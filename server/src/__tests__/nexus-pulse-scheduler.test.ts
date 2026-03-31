import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  NexusPulseScheduler,
  PulseTaskPriority,
  getNexusPulseSchedulerHealth,
  nexusPulseScheduler,
  type PulseTask,
} from "../services/nexus-pulse-scheduler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<PulseTask> & { key: string }): PulseTask {
  return {
    priority: PulseTaskPriority.NORMAL,
    enqueuedAt: Date.now(),
    execute: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic enqueue / drain
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – enqueue & drain", () => {
  let scheduler: NexusPulseScheduler;

  beforeEach(() => {
    scheduler = new NexusPulseScheduler({ maxConcurrency: 2, maxQueueDepth: 10 });
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  it("accepts a task and increments enqueued counter", () => {
    const task = makeTask({ key: "t1" });
    const accepted = scheduler.enqueue(task);
    expect(accepted).toBe(true);
    expect(scheduler.getStats().enqueued).toBe(1);
  });

  it("executes the task", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    scheduler.enqueue(makeTask({ key: "t2", execute }));
    // Wait one microtask tick for the drain promise to settle
    await Promise.resolve();
    await Promise.resolve();
    await vi.waitFor(() => expect(scheduler.getStats().completed).toBe(1));
    expect(execute).toHaveBeenCalledOnce();
  });

  it("drops tasks when queue is full and increments dropped counter", () => {
    const tiny = new NexusPulseScheduler({ maxConcurrency: 0, maxQueueDepth: 2 });
    try {
      tiny.enqueue(makeTask({ key: "a" }));
      tiny.enqueue(makeTask({ key: "b" }));
      const accepted = tiny.enqueue(makeTask({ key: "c" }));
      expect(accepted).toBe(false);
      expect(tiny.getStats().dropped).toBe(1);
    } finally {
      tiny.shutdown();
    }
  });

  it("respects maxConcurrency", async () => {
    let running = 0;
    let maxSeen = 0;
    const serial = new NexusPulseScheduler({ maxConcurrency: 1, maxQueueDepth: 100 });
    const tasks = Array.from({ length: 5 }, (_, i) =>
      makeTask({
        key: `serial-${i}`,
        execute: async () => {
          running++;
          maxSeen = Math.max(maxSeen, running);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          running--;
        },
      }),
    );
    for (const t of tasks) serial.enqueue(t);
    await vi.waitFor(() => expect(serial.getStats().completed).toBe(5), { timeout: 2000 });
    expect(maxSeen).toBe(1);
    serial.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – priority ordering", () => {
  it("drains higher-priority tasks before lower-priority ones", async () => {
    const order: string[] = [];
    // Use maxConcurrency: 1 so tasks execute serially in priority order
    const scheduler = new NexusPulseScheduler({ maxConcurrency: 1, maxQueueDepth: 100 });

    // Enqueue at different priorities — CRITICAL should run before IDLE
    const idle = makeTask({
      key: "idle",
      priority: PulseTaskPriority.IDLE,
      execute: async () => { order.push("IDLE"); },
    });
    const critical = makeTask({
      key: "critical",
      priority: PulseTaskPriority.CRITICAL,
      execute: async () => { order.push("CRITICAL"); },
    });
    const normal = makeTask({
      key: "normal",
      priority: PulseTaskPriority.NORMAL,
      execute: async () => { order.push("NORMAL"); },
    });

    scheduler.enqueue(idle);
    scheduler.enqueue(critical);
    scheduler.enqueue(normal);

    await vi.waitFor(() => expect(scheduler.getStats().completed).toBe(3), { timeout: 2000 });
    // CRITICAL (0) < NORMAL (2) < IDLE (4) — lower number = higher priority
    expect(order[0]).toBe("CRITICAL");
    expect(order[1]).toBe("NORMAL");
    expect(order[2]).toBe("IDLE");
    scheduler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – circuit breaker", () => {
  it("opens the circuit after repeated failures and blocks the key", async () => {
    const THRESHOLD = 3;
    const scheduler = new NexusPulseScheduler({
      maxConcurrency: 4,
      maxQueueDepth: 100,
    });

    // Enqueue THRESHOLD failing tasks to trip the breaker
    for (let i = 0; i < THRESHOLD; i++) {
      scheduler.enqueue(
        makeTask({
          key: "flaky",
          execute: async () => { throw new Error("boom"); },
        }),
      );
    }

    await vi.waitFor(() => expect(scheduler.getStats().failed).toBe(THRESHOLD), { timeout: 2000 });

    // Next enqueue for same key should be circuit-broken
    const accepted = scheduler.enqueue(makeTask({ key: "flaky" }));
    expect(accepted).toBe(false);
    expect(scheduler.getStats().circuitBroken).toBeGreaterThanOrEqual(1);

    scheduler.shutdown();
  });

  it("getCircuitBreakerSnapshot returns open breaker info", async () => {
    const THRESHOLD = 3;
    const scheduler = new NexusPulseScheduler({ maxConcurrency: 4, maxQueueDepth: 100 });

    for (let i = 0; i < THRESHOLD; i++) {
      scheduler.enqueue(
        makeTask({ key: "snappy", execute: async () => { throw new Error("x"); } }),
      );
    }
    await vi.waitFor(() => expect(scheduler.getStats().failed).toBe(THRESHOLD), { timeout: 2000 });

    const snap = scheduler.getCircuitBreakerSnapshot();
    expect(snap.length).toBeGreaterThan(0);
    const entry = snap.find((e) => e.key === "snappy");
    expect(entry).toBeDefined();
    expect(entry!.failures).toBeGreaterThanOrEqual(THRESHOLD);
    expect(entry!.backoffRemainingMs).toBeGreaterThan(0);

    scheduler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Back-pressure
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – back-pressure", () => {
  it("drops when queue is saturated", () => {
    // concurrency = 0 means tasks sit in queue
    const scheduler = new NexusPulseScheduler({ maxConcurrency: 0, maxQueueDepth: 3 });
    scheduler.enqueue(makeTask({ key: "p1" }));
    scheduler.enqueue(makeTask({ key: "p2" }));
    scheduler.enqueue(makeTask({ key: "p3" }));
    const dropped = scheduler.enqueue(makeTask({ key: "p4" }));
    expect(dropped).toBe(false);
    expect(scheduler.getStats().dropped).toBe(1);
    expect(scheduler.getStats().currentQueueDepth).toBe(3);
    scheduler.shutdown();
  });
});

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – shutdown", () => {
  it("shutdown() stops the aging timer without throwing", () => {
    const s = new NexusPulseScheduler({ maxConcurrency: 2, maxQueueDepth: 100 });
    expect(() => s.shutdown()).not.toThrow();
    // Second call should be idempotent
    expect(() => s.shutdown()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// getNexusPulseSchedulerHealth (singleton wrapper)
// ---------------------------------------------------------------------------

describe("getNexusPulseSchedulerHealth", () => {
  it("returns a well-formed health report", () => {
    const report = getNexusPulseSchedulerHealth();
    expect(report).toHaveProperty("queueDepth");
    expect(report).toHaveProperty("activeCount");
    expect(report).toHaveProperty("stats");
    expect(Array.isArray(report.circuitBreakers)).toBe(true);
    // With no open breakers the snapshot should be empty
    expect(report.circuitBreakers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FIFO tie-breaking within same priority tier
// ---------------------------------------------------------------------------

describe("NexusPulseScheduler – FIFO within same tier", () => {
  it("executes same-priority tasks in enqueue order", async () => {
    const order: number[] = [];
    const scheduler = new NexusPulseScheduler({ maxConcurrency: 1, maxQueueDepth: 100 });

    for (let i = 0; i < 5; i++) {
      const idx = i;
      scheduler.enqueue(
        makeTask({
          key: `fifo-${i}`,
          priority: PulseTaskPriority.NORMAL,
          enqueuedAt: Date.now() + i, // ensure distinct timestamps
          execute: async () => { order.push(idx); },
        }),
      );
    }

    await vi.waitFor(() => expect(scheduler.getStats().completed).toBe(5), { timeout: 2000 });
    expect(order).toEqual([0, 1, 2, 3, 4]);
    scheduler.shutdown();
  });
});
