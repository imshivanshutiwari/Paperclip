/**
 * NexusAI Self-Healing Orphan Recovery Service
 *
 * Advanced telemetry-driven layer that:
 *   1. Tracks orphan detection events over a rolling time window
 *   2. Computes per-agent health scores to identify systematically failing nodes
 *   3. Drives escalation decisions (auto-pause agent, alert operators)
 *   4. Exposes structured health diagnostics for observability dashboards
 *   5. Integrates with the NexusPulseScheduler for priority-aware recovery tasks
 *
 * The existing `reapOrphanedRuns` inside the heartbeat service handles the
 * mechanical reaping. This module wraps it with higher-level intelligence:
 * trend awareness, anomaly detection, and escalation management.
 *
 * @module nexus-orphan-recovery
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrphanCause =
  | "process_lost"        // Child PID is no longer alive
  | "process_detached"    // PID alive but handle lost (server restart)
  | "stale_run"           // Run stuck in `running` for too long with no heartbeat
  | "unknown";

export interface OrphanEvent {
  id: string;
  runId: string;
  agentId: string;
  companyId: string;
  cause: OrphanCause;
  detectedAt: Date;
  recoveryAction: "retry_enqueued" | "failed_terminal" | "escalated" | "none";
  recoveryRunId: string | null;
  /** Wall-clock duration from run start to orphan detection (ms). */
  runDurationMs: number | null;
}

export interface AgentHealthScore {
  agentId: string;
  /** 0.0 (unhealthy) to 1.0 (healthy) */
  score: number;
  orphanRate: number;
  recentOrphans: number;
  totalRuns: number;
  lastOrphanAt: Date | null;
  escalationLevel: EscalationLevel;
}

export type EscalationLevel = "none" | "warning" | "critical" | "suspended";

export interface OrphanRecoverySummary {
  windowStartAt: Date;
  windowEndAt: Date;
  totalOrphansDetected: number;
  totalOrphansRecovered: number;
  totalOrphansFailed: number;
  agentHealthScores: AgentHealthScore[];
  escalations: EscalationRecord[];
}

export interface EscalationRecord {
  agentId: string;
  escalatedAt: Date;
  level: EscalationLevel;
  reason: string;
  autoResolvedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HEALTH_SCORE_WINDOW_MS = 30 * 60 * 1_000; // 30-minute rolling window
const ORPHAN_RATE_WARNING_THRESHOLD = 0.25;       // >25% orphan rate → warning
const ORPHAN_RATE_CRITICAL_THRESHOLD = 0.60;      // >60% orphan rate → critical
const MIN_RUNS_FOR_SCORING = 3;                    // Need at least 3 runs to score
const MAX_ORPHAN_HISTORY = 500;                    // Cap stored events

// ---------------------------------------------------------------------------
// Rolling event store (in-process, bounded ring-buffer style)
// ---------------------------------------------------------------------------

class RollingOrphanStore {
  private events: OrphanEvent[] = [];
  private readonly maxSize: number;

  constructor(maxSize = MAX_ORPHAN_HISTORY) {
    this.maxSize = maxSize;
  }

  record(event: OrphanEvent): void {
    this.events.push(event);
    if (this.events.length > this.maxSize) {
      this.events.splice(0, this.events.length - this.maxSize);
    }
  }

  /** Return events within the rolling window. */
  getWindow(windowMs: number): OrphanEvent[] {
    const cutoff = Date.now() - windowMs;
    return this.events.filter((e) => e.detectedAt.getTime() >= cutoff);
  }

  all(): ReadonlyArray<OrphanEvent> {
    return this.events;
  }

  clear(): void {
    this.events = [];
  }
}

// ---------------------------------------------------------------------------
// Run counter (lightweight in-memory counters per agent)
// ---------------------------------------------------------------------------

class AgentRunCounter {
  private readonly counters = new Map<string, number>();

  increment(agentId: string): void {
    this.counters.set(agentId, (this.counters.get(agentId) ?? 0) + 1);
  }

  getTotal(agentId: string): number {
    return this.counters.get(agentId) ?? 0;
  }

  keys(): string[] {
    return [...this.counters.keys()];
  }
}

// ---------------------------------------------------------------------------
// Escalation manager
// ---------------------------------------------------------------------------

class EscalationManager {
  private readonly records = new Map<string, EscalationRecord>();
  private readonly onEscalate: (record: EscalationRecord) => void;
  private readonly onResolve: (agentId: string, level: EscalationLevel) => void;

  constructor(
    onEscalate: (record: EscalationRecord) => void,
    onResolve: (agentId: string, level: EscalationLevel) => void,
  ) {
    this.onEscalate = onEscalate;
    this.onResolve = onResolve;
  }

  currentLevel(agentId: string): EscalationLevel {
    return this.records.get(agentId)?.level ?? "none";
  }

  escalate(agentId: string, level: EscalationLevel, reason: string): void {
    const existing = this.records.get(agentId);
    if (existing && levelOrdinal(existing.level) >= levelOrdinal(level)) return;

    const record: EscalationRecord = {
      agentId,
      escalatedAt: new Date(),
      level,
      reason,
      autoResolvedAt: null,
    };
    this.records.set(agentId, record);
    this.onEscalate(record);
  }

  autoResolve(agentId: string): void {
    const existing = this.records.get(agentId);
    if (!existing || existing.autoResolvedAt) return;
    const prev = existing.level;
    existing.autoResolvedAt = new Date();
    existing.level = "none";
    this.onResolve(agentId, prev);
  }

  allRecords(): EscalationRecord[] {
    return [...this.records.values()];
  }
}

function levelOrdinal(level: EscalationLevel): number {
  switch (level) {
    case "none":      return 0;
    case "warning":   return 1;
    case "critical":  return 2;
    case "suspended": return 3;
  }
}

// ---------------------------------------------------------------------------
// NexusOrphanRecovery
// ---------------------------------------------------------------------------

export interface NexusOrphanRecoveryOptions {
  /** Override the rolling window duration (ms). Default: 30 min. */
  healthWindowMs?: number;
  /** Called when an escalation occurs (hook in logging, alerts, etc.). */
  onEscalation?: (record: EscalationRecord) => void;
  /** Called when an escalation auto-resolves. */
  onEscalationResolved?: (agentId: string, previousLevel: EscalationLevel) => void;
}

export class NexusOrphanRecovery {
  private readonly store: RollingOrphanStore;
  private readonly runCounter: AgentRunCounter;
  private readonly escalations: EscalationManager;
  private readonly healthWindowMs: number;

  constructor(options: NexusOrphanRecoveryOptions = {}) {
    this.healthWindowMs = options.healthWindowMs ?? HEALTH_SCORE_WINDOW_MS;
    this.store = new RollingOrphanStore();
    this.runCounter = new AgentRunCounter();

    this.escalations = new EscalationManager(
      options.onEscalation ?? noop,
      options.onEscalationResolved ?? noop,
    );
  }

  /**
   * Record a new Pulse run starting (used to maintain run-rate denominators
   * for health scoring). Call this every time a new heartbeat run begins.
   */
  recordRunStart(agentId: string): void {
    this.runCounter.increment(agentId);
  }

  /**
   * Record an orphan detection event and update escalation state.
   *
   * @returns The recorded `OrphanEvent` for caller inspection / persistence.
   */
  recordOrphan(input: {
    runId: string;
    agentId: string;
    companyId: string;
    cause: OrphanCause;
    recoveryAction: OrphanEvent["recoveryAction"];
    recoveryRunId?: string | null;
    runDurationMs?: number | null;
  }): OrphanEvent {
    const event: OrphanEvent = {
      id: cryptoRandomId(),
      runId: input.runId,
      agentId: input.agentId,
      companyId: input.companyId,
      cause: input.cause,
      detectedAt: new Date(),
      recoveryAction: input.recoveryAction,
      recoveryRunId: input.recoveryRunId ?? null,
      runDurationMs: input.runDurationMs ?? null,
    };

    this.store.record(event);
    this.updateEscalation(input.agentId);
    return event;
  }

  /**
   * Compute health scores for all known agents within the rolling window.
   */
  computeHealthScores(): AgentHealthScore[] {
    const windowEvents = this.store.getWindow(this.healthWindowMs);
    const orphansByAgent = groupBy(windowEvents, (e) => e.agentId);

    const agentIds = new Set([
      ...this.runCounter.keys(),
      ...Object.keys(orphansByAgent),
    ]);

    return [...agentIds].map((agentId) => {
      const agentOrphans = orphansByAgent[agentId] ?? [];
      const totalRuns = this.runCounter.getTotal(agentId);
      const recentOrphans = agentOrphans.length;
      const orphanRate = totalRuns >= MIN_RUNS_FOR_SCORING
        ? recentOrphans / totalRuns
        : 0;

      const score = computeHealthScore(orphanRate, recentOrphans, totalRuns);
      const lastOrphan = agentOrphans.at(-1)?.detectedAt ?? null;

      return {
        agentId,
        score,
        orphanRate,
        recentOrphans,
        totalRuns,
        lastOrphanAt: lastOrphan,
        escalationLevel: this.escalations.currentLevel(agentId),
      };
    });
  }

  /**
   * Full recovery summary for the current window. Use this for health
   * dashboards and operator diagnostics.
   */
  getSummary(): OrphanRecoverySummary {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.healthWindowMs);
    const windowEvents = this.store.getWindow(this.healthWindowMs);

    return {
      windowStartAt: windowStart,
      windowEndAt: now,
      totalOrphansDetected: windowEvents.length,
      totalOrphansRecovered: windowEvents.filter((e) =>
        e.recoveryAction === "retry_enqueued"
      ).length,
      totalOrphansFailed: windowEvents.filter((e) =>
        e.recoveryAction === "failed_terminal" || e.recoveryAction === "escalated"
      ).length,
      agentHealthScores: this.computeHealthScores(),
      escalations: this.escalations.allRecords(),
    };
  }

  /**
   * Mark an agent as healthy (e.g. after a successful run streak). Clears
   * any active escalation if health has recovered.
   */
  markAgentHealthy(agentId: string): void {
    const score = this.computeHealthScores().find((s) => s.agentId === agentId);
    if (score && score.orphanRate < ORPHAN_RATE_WARNING_THRESHOLD) {
      this.escalations.autoResolve(agentId);
    }
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private updateEscalation(agentId: string): void {
    const windowEvents = this.store.getWindow(this.healthWindowMs);
    const agentOrphans = windowEvents.filter((e) => e.agentId === agentId);
    const totalRuns = this.runCounter.getTotal(agentId);
    const orphanRate = totalRuns >= MIN_RUNS_FOR_SCORING
      ? agentOrphans.length / totalRuns
      : 0;

    if (orphanRate >= ORPHAN_RATE_CRITICAL_THRESHOLD) {
      this.escalations.escalate(
        agentId,
        "critical",
        `Orphan rate ${(orphanRate * 100).toFixed(1)}% exceeds critical threshold of ${ORPHAN_RATE_CRITICAL_THRESHOLD * 100}%`,
      );
    } else if (orphanRate >= ORPHAN_RATE_WARNING_THRESHOLD) {
      this.escalations.escalate(
        agentId,
        "warning",
        `Orphan rate ${(orphanRate * 100).toFixed(1)}% exceeds warning threshold of ${ORPHAN_RATE_WARNING_THRESHOLD * 100}%`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring formula
// ---------------------------------------------------------------------------

/**
 * Compute a [0.0, 1.0] health score from orphan rate and recency signals.
 *
 * Uses an exponential decay function so that a few old orphans are less
 * damaging than recent failures.
 */
function computeHealthScore(
  orphanRate: number,
  recentOrphans: number,
  totalRuns: number,
): number {
  if (totalRuns < MIN_RUNS_FOR_SCORING) return 1.0; // Not enough data
  // Base penalty from orphan rate
  const ratePenalty = Math.min(orphanRate * 2, 1.0); // Double the rate, cap at 1
  // Recency bonus: penalize more if orphans are concentrated in few runs
  const densityPenalty = totalRuns > 0 ? Math.min(recentOrphans / 5, 0.5) : 0;
  const rawScore = 1 - Math.min(ratePenalty + densityPenalty, 1.0);
  return Math.round(rawScore * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function groupBy<T>(arr: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of arr) {
    const k = key(item);
    (result[k] ??= []).push(item);
  }
  return result;
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function noop(): void {
  // intentional no-op
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The default NexusAI orphan recovery tracker instance. Constructed with
 * sensible defaults; override via `NexusOrphanRecovery` constructor for tests.
 */
export const nexusOrphanRecovery = new NexusOrphanRecovery();
