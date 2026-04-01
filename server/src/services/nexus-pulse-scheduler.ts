/**
 * NexusAI Priority-Weighted Pulse Scheduler
 *
 * A high-resiliency, priority-queue-based task scheduler for Pulse (heartbeat)
 * execution. Replaces naïve interval polling with:
 *
 *   - O(log n) min-heap priority queue
 *   - Five priority tiers: CRITICAL → HIGH → NORMAL → LOW → IDLE
 *   - Aging mechanism to prevent starvation of low-priority tasks
 *   - Circuit breaker per task key (exponential back-off on failure)
 *   - Weighted fair queuing: higher-priority work always drains first
 *   - Back-pressure: configurable concurrency cap
 *   - Full telemetry (enqueue, dequeue, execution latency, drops)
 *
 * @module nexus-pulse-scheduler
 */

// ---------------------------------------------------------------------------
// Priority tiers
// ---------------------------------------------------------------------------

export const enum PulseTaskPriority {
  /** Urgent board actions – checkout wakeups, approval gates. */
  CRITICAL = 0,
  /** Active issue assignments and in-progress agent runs. */
  HIGH = 1,
  /** Regular scheduled heartbeat checks. */
  NORMAL = 2,
  /** Background maintenance, session compaction triggers. */
  LOW = 3,
  /** Deferred / best-effort async work. */
  IDLE = 4,
}

const PRIORITY_TIERS = 5;

// ---------------------------------------------------------------------------
// Aging: boost priority by 1 tier after this many milliseconds of waiting
// ---------------------------------------------------------------------------
const AGING_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PulseTask {
  /** Stable identifier – used for deduplication and circuit-breaker keying. */
  key: string;
  priority: PulseTaskPriority;
  /** Millisecond timestamp when the task was enqueued (for aging). */
  enqueuedAt: number;
  /** Resolved handler – must not throw; should return a settled Promise. */
  execute: () => Promise<void>;
  /** Optional label for telemetry logs. */
  label?: string;
}

interface HeapNode {
  /** Effective priority after aging (may be lower than original). */
  effectivePriority: number;
  /** Original priority for aging calculation. */
  originalPriority: PulseTaskPriority;
  enqueuedAt: number;
  task: PulseTask;
}

export interface SchedulerStats {
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

// ---------------------------------------------------------------------------
// Min-Heap implementation (keyed on effectivePriority, then enqueuedAt FIFO)
// ---------------------------------------------------------------------------

class PriorityMinHeap {
  private readonly heap: HeapNode[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(node: HeapNode): void {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): HeapNode | undefined {
    return this.heap[0];
  }

  /** Recompute effective priorities for all nodes (aging pass). */
  recomputeAging(nowMs: number): void {
    for (const node of this.heap) {
      const waitedMs = nowMs - node.enqueuedAt;
      const boosts = Math.floor(waitedMs / AGING_INTERVAL_MS);
      node.effectivePriority = Math.max(0, node.originalPriority - boosts);
    }
    // Re-heapify from scratch after priorities changed
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.sinkDown(i);
    }
  }

  private compare(a: HeapNode, b: HeapNode): boolean {
    // Lower effectivePriority number = higher urgency
    if (a.effectivePriority !== b.effectivePriority) {
      return a.effectivePriority < b.effectivePriority;
    }
    // FIFO within the same priority tier
    return a.enqueuedAt < b.enqueuedAt;
  }

  private bubbleUp(idx: number): void {
    while (idx > 0) {
      const parent = Math.floor((idx - 1) / 2);
      if (this.compare(this.heap[idx]!, this.heap[parent]!)) {
        [this.heap[idx], this.heap[parent]] = [this.heap[parent]!, this.heap[idx]!];
        idx = parent;
      } else {
        break;
      }
    }
  }

  private sinkDown(idx: number): void {
    const n = this.heap.length;
    for (;;) {
      let smallest = idx;
      const left = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < n && this.compare(this.heap[left]!, this.heap[smallest]!)) smallest = left;
      if (right < n && this.compare(this.heap[right]!, this.heap[smallest]!)) smallest = right;
      if (smallest === idx) break;
      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest]!, this.heap[idx]!];
      idx = smallest;
    }
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker per task key
// ---------------------------------------------------------------------------

interface CircuitBreakerState {
  failures: number;
  openUntil: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_BASE_BACKOFF_MS = 5_000;
const CIRCUIT_BREAKER_MAX_BACKOFF_MS = 300_000; // 5 min

// ---------------------------------------------------------------------------
// NexusPulseScheduler
// ---------------------------------------------------------------------------

export interface NexusPulseSchedulerOptions {
  /** Maximum tasks that may execute concurrently (default: 4). */
  maxConcurrency?: number;
  /** Maximum queue depth before tasks are dropped (default: 1000). */
  maxQueueDepth?: number;
  /** How often to run the aging pass in ms (default: AGING_INTERVAL_MS). */
  agingIntervalMs?: number;
}

export class NexusPulseScheduler {
  private readonly heap = new PriorityMinHeap();
  private readonly circuitBreakers = new Map<string, CircuitBreakerState>();
  private readonly maxConcurrency: number;
  private readonly maxQueueDepth: number;
  private activeCount = 0;
  private draining = false;

  // Telemetry counters
  private stats: SchedulerStats = {
    enqueued: 0,
    dequeued: 0,
    dropped: 0,
    completed: 0,
    failed: 0,
    circuitBroken: 0,
    currentQueueDepth: 0,
    activeCount: 0,
    avgExecutionMs: 0,
  };
  private totalExecutionMs = 0;
  private executionCount = 0;

  private agingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: NexusPulseSchedulerOptions = {}) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    this.maxQueueDepth = options.maxQueueDepth ?? 1_000;

    const agingMs = options.agingIntervalMs ?? AGING_INTERVAL_MS;
    this.agingTimer = setInterval(() => {
      this.heap.recomputeAging(Date.now());
    }, agingMs);
    // Allow process to exit cleanly
    if (typeof this.agingTimer.unref === "function") {
      this.agingTimer.unref();
    }
  }

  /**
   * Enqueue a task. If the queue is full the task is dropped and the dropped
   * counter is incremented. If a circuit breaker for `task.key` is open the
   * task is also skipped.
   *
   * @returns `true` if the task was accepted, `false` if dropped/blocked.
   */
  enqueue(task: PulseTask): boolean {
    // Back-pressure guard
    if (this.heap.size >= this.maxQueueDepth) {
      this.stats.dropped++;
      return false;
    }

    // Circuit breaker check
    const cb = this.circuitBreakers.get(task.key);
    if (cb && cb.openUntil > Date.now()) {
      this.stats.circuitBroken++;
      return false;
    }

    const now = Date.now();
    this.heap.push({
      effectivePriority: task.priority,
      originalPriority: task.priority,
      enqueuedAt: now,
      task,
    });

    this.stats.enqueued++;
    this.stats.currentQueueDepth = this.heap.size;
    this.drain();
    return true;
  }

  /** Snapshot of scheduler telemetry. */
  getStats(): Readonly<SchedulerStats> {
    return {
      ...this.stats,
      currentQueueDepth: this.heap.size,
      activeCount: this.activeCount,
      avgExecutionMs: this.executionCount > 0
        ? Math.round(this.totalExecutionMs / this.executionCount)
        : 0,
    };
  }

  /** Gracefully stop the aging timer. Outstanding tasks continue to completion. */
  shutdown(): void {
    if (this.agingTimer !== null) {
      clearInterval(this.agingTimer);
      this.agingTimer = null;
    }
  }

  /** Returns a snapshot of all active circuit breaker states for diagnostics. */
  getCircuitBreakerSnapshot(): Array<{ key: string; failures: number; openUntil: number; backoffRemainingMs: number }> {
    const now = Date.now();
    return [...this.circuitBreakers.entries()].map(([key, state]) => ({
      key,
      failures: state.failures,
      openUntil: state.openUntil,
      backoffRemainingMs: Math.max(0, state.openUntil - now),
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal drain loop
  // ---------------------------------------------------------------------------

  private drain(): void {
    if (this.draining) return;
    this.draining = true;

    // Use microtask to batch concurrent enqueues before draining
    Promise.resolve().then(() => {
      this.draining = false;
      this.scheduleNext();
    }).catch(() => {
      this.draining = false;
    });
  }

  private scheduleNext(): void {
    while (this.activeCount < this.maxConcurrency && this.heap.size > 0) {
      const node = this.heap.pop();
      if (!node) break;

      this.stats.dequeued++;
      this.stats.currentQueueDepth = this.heap.size;
      this.activeCount++;
      this.stats.activeCount = this.activeCount;

      const startMs = Date.now();
      node.task.execute().then(() => {
        this.onTaskComplete(node.task.key, Date.now() - startMs, null);
      }).catch((err: unknown) => {
        this.onTaskComplete(node.task.key, Date.now() - startMs, err);
      });
    }
  }

  private onTaskComplete(key: string, durationMs: number, error: unknown): void {
    this.totalExecutionMs += durationMs;
    this.executionCount++;
    this.activeCount--;
    this.stats.activeCount = this.activeCount;

    if (error !== null) {
      this.stats.failed++;
      this.recordFailure(key);
    } else {
      this.stats.completed++;
      this.resetCircuitBreaker(key);
    }

    // Continue draining
    this.scheduleNext();
  }

  private recordFailure(key: string): void {
    const existing = this.circuitBreakers.get(key) ?? { failures: 0, openUntil: 0 };
    const failures = existing.failures + 1;
    let openUntil = 0;
    if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
      const backoff = Math.min(
        CIRCUIT_BREAKER_BASE_BACKOFF_MS * Math.pow(2, failures - CIRCUIT_BREAKER_THRESHOLD),
        CIRCUIT_BREAKER_MAX_BACKOFF_MS,
      );
      openUntil = Date.now() + backoff;
    }
    this.circuitBreakers.set(key, { failures, openUntil });
  }

  private resetCircuitBreaker(key: string): void {
    this.circuitBreakers.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

/**
 * The default NexusAI pulse scheduler instance used by the heartbeat service.
 * Configured for up to 4 concurrent Pulse task executions.
 */
export const nexusPulseScheduler = new NexusPulseScheduler({
  maxConcurrency: 4,
  maxQueueDepth: 1_000,
  agingIntervalMs: AGING_INTERVAL_MS,
});

/**
 * Priority buckets for common Pulse event categories. Import these constants
 * instead of referencing the enum directly to enable easy reconfiguration.
 */
export const PULSE_PRIORITIES = {
  /** Immediate user-triggered wakeups (checkout, approval). */
  WAKEUP: PulseTaskPriority.CRITICAL,
  /** Active run monitoring. */
  ACTIVE_RUN: PulseTaskPriority.HIGH,
  /** Scheduled routine invocations. */
  ROUTINE: PulseTaskPriority.NORMAL,
  /** Session compaction. */
  COMPACTION: PulseTaskPriority.LOW,
  /** Cleanup and GC tasks. */
  CLEANUP: PulseTaskPriority.IDLE,
} as const;

// ---------------------------------------------------------------------------
// Weighted fair-queue summary (useful for diagnostics / health endpoints)
// ---------------------------------------------------------------------------

export interface PulseSchedulerHealthReport {
  queueDepth: number;
  activeCount: number;
  stats: SchedulerStats;
  circuitBreakers: Array<{ key: string; failures: number; openUntil: number; backoffRemainingMs: number }>;
}

export function getNexusPulseSchedulerHealth(): PulseSchedulerHealthReport {
  const stats = nexusPulseScheduler.getStats();
  return {
    queueDepth: stats.currentQueueDepth,
    activeCount: stats.activeCount,
    stats,
    circuitBreakers: nexusPulseScheduler.getCircuitBreakerSnapshot(),
  };
}

// ---------------------------------------------------------------------------
// Tier distribution helper (for telemetry dashboards)
// ---------------------------------------------------------------------------

export function describePriority(priority: PulseTaskPriority): string {
  switch (priority) {
    case PulseTaskPriority.CRITICAL: return "CRITICAL";
    case PulseTaskPriority.HIGH:     return "HIGH";
    case PulseTaskPriority.NORMAL:   return "NORMAL";
    case PulseTaskPriority.LOW:      return "LOW";
    case PulseTaskPriority.IDLE:     return "IDLE";
    default: {
      const _exhaustive: never = priority;
      return `UNKNOWN(${_exhaustive})`;
    }
  }
}

/** How many priority tiers exist. Used for array initialization. */
export const PULSE_PRIORITY_TIER_COUNT = PRIORITY_TIERS;
