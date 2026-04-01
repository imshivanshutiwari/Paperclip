const BASE = "/api";

export interface NexusSchedulerStats {
  enqueued: number;
  dequeued: number;
  dropped: number;
  completed: number;
  failed: number;
  circuitBroken: number;
  currentQueueDepth: number;
  activeCount: number;
  avgExecutionMs: number;
}

export interface NexusCircuitBreaker {
  key: string;
  failures: number;
  openUntil: number;
  backoffRemainingMs: number;
}

export interface NexusSchedulerHealth {
  queueDepth: number;
  activeCount: number;
  stats: NexusSchedulerStats;
  circuitBreakers: NexusCircuitBreaker[];
}

export type NexusEscalationLevel = "none" | "warning" | "critical" | "suspended";

export interface NexusAgentHealthScore {
  agentId: string;
  score: number;
  orphanRate: number;
  recentOrphans: number;
  totalRuns: number;
  lastOrphanAt: string | null;
  escalationLevel: NexusEscalationLevel;
}

export interface NexusEscalationRecord {
  agentId: string;
  escalatedAt: string;
  level: NexusEscalationLevel;
  reason: string;
  autoResolvedAt: string | null;
}

export interface NexusOrphanRecoverySummary {
  windowStartAt: string;
  windowEndAt: string;
  totalOrphansDetected: number;
  totalOrphansRecovered: number;
  totalOrphansFailed: number;
  agentHealthScores: NexusAgentHealthScore[];
  escalations: NexusEscalationRecord[];
}

export interface NexusHealthReport {
  scheduler: NexusSchedulerHealth;
  orphanRecovery: NexusOrphanRecoverySummary;
}

export const nexusHealthApi = {
  get: async (): Promise<NexusHealthReport> => {
    const res = await fetch(`${BASE}/health/nexus`, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to load nexus health (${res.status})`);
    }
    return res.json();
  },
};
