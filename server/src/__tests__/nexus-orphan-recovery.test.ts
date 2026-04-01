import { describe, it, expect, vi } from "vitest";
import {
  NexusOrphanRecovery,
  type OrphanCause,
  type EscalationRecord,
  type EscalationLevel,
} from "../services/nexus-orphan-recovery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;
function makeOrphanInput(overrides: Partial<{
  runId: string;
  agentId: string;
  companyId: string;
  cause: OrphanCause;
  recoveryAction: "retry_enqueued" | "failed_terminal" | "escalated" | "none";
  runDurationMs: number;
}> = {}) {
  seq++;
  return {
    runId: `run-${seq}`,
    agentId: overrides.agentId ?? "agent-a",
    companyId: overrides.companyId ?? "company-1",
    cause: overrides.cause ?? ("stale_run" as OrphanCause),
    recoveryAction: overrides.recoveryAction ?? ("retry_enqueued" as const),
    runDurationMs: overrides.runDurationMs ?? 5000,
  };
}

// ---------------------------------------------------------------------------
// recordOrphan / getSummary basics
// ---------------------------------------------------------------------------

describe("NexusOrphanRecovery – recordOrphan", () => {
  it("records an orphan event and increments totalOrphansDetected", () => {
    const r = new NexusOrphanRecovery();
    r.recordOrphan(makeOrphanInput());
    const summary = r.getSummary();
    expect(summary.totalOrphansDetected).toBe(1);
  });

  it("returned event has all required fields", () => {
    const r = new NexusOrphanRecovery();
    const input = makeOrphanInput({ agentId: "ag-1", cause: "process_lost", recoveryAction: "retry_enqueued", runDurationMs: 1234 });
    const event = r.recordOrphan(input);
    expect(event.id).toBeTruthy();
    expect(event.runId).toBe(input.runId);
    expect(event.agentId).toBe("ag-1");
    expect(event.cause).toBe("process_lost");
    expect(event.recoveryAction).toBe("retry_enqueued");
    expect(event.runDurationMs).toBe(1234);
    expect(event.detectedAt).toBeInstanceOf(Date);
    expect(event.recoveryRunId).toBeNull();
  });

  it("tallies recovered vs failed correctly", () => {
    const r = new NexusOrphanRecovery();
    r.recordOrphan(makeOrphanInput({ recoveryAction: "retry_enqueued" }));
    r.recordOrphan(makeOrphanInput({ recoveryAction: "retry_enqueued" }));
    r.recordOrphan(makeOrphanInput({ recoveryAction: "failed_terminal" }));
    r.recordOrphan(makeOrphanInput({ recoveryAction: "escalated" }));
    const summary = r.getSummary();
    expect(summary.totalOrphansRecovered).toBe(2);
    expect(summary.totalOrphansFailed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordRunStart / health scoring
// ---------------------------------------------------------------------------

describe("NexusOrphanRecovery – health scoring", () => {
  it("returns score 1.0 when fewer than MIN_RUNS_FOR_SCORING runs recorded", () => {
    const r = new NexusOrphanRecovery();
    r.recordRunStart("ag-x");
    r.recordOrphan(makeOrphanInput({ agentId: "ag-x" }));
    const scores = r.computeHealthScores();
    const score = scores.find((s) => s.agentId === "ag-x");
    expect(score?.score).toBe(1.0); // Not enough runs to penalise
  });

  it("reduces health score as orphan rate rises", () => {
    const r = new NexusOrphanRecovery();
    // 10 runs, 7 orphans – orphan rate 70%
    for (let i = 0; i < 10; i++) r.recordRunStart("ag-y");
    for (let i = 0; i < 7; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-y" }));
    const scores = r.computeHealthScores();
    const score = scores.find((s) => s.agentId === "ag-y");
    expect(score).toBeDefined();
    expect(score!.score).toBeLessThan(0.5);
  });

  it("healthy agent keeps score near 1.0", () => {
    const r = new NexusOrphanRecovery();
    for (let i = 0; i < 20; i++) r.recordRunStart("ag-healthy");
    // No orphans
    const scores = r.computeHealthScores();
    const score = scores.find((s) => s.agentId === "ag-healthy");
    // Agent appears in runCounter but has no orphans, so score 1.0
    expect(score?.score).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// Escalation progression
// ---------------------------------------------------------------------------

describe("NexusOrphanRecovery – escalation", () => {
  it("starts at 'none' escalation level", () => {
    const r = new NexusOrphanRecovery();
    const summary = r.getSummary();
    expect(summary.escalations).toHaveLength(0);
  });

  it("escalates to warning when orphan rate exceeds 25%", () => {
    const r = new NexusOrphanRecovery();
    // 4 runs, 2 orphans = 50% orphan rate > 25% threshold
    for (let i = 0; i < 4; i++) r.recordRunStart("ag-w");
    r.recordOrphan(makeOrphanInput({ agentId: "ag-w" }));
    r.recordOrphan(makeOrphanInput({ agentId: "ag-w" }));
    const scores = r.computeHealthScores();
    const score = scores.find((s) => s.agentId === "ag-w");
    expect(["warning", "critical"]).toContain(score?.escalationLevel);
  });

  it("escalates to critical when orphan rate exceeds 60%", () => {
    const r = new NexusOrphanRecovery();
    // 5 runs, 4 orphans = 80% orphan rate > 60% threshold
    for (let i = 0; i < 5; i++) r.recordRunStart("ag-c");
    for (let i = 0; i < 4; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-c" }));
    const scores = r.computeHealthScores();
    const score = scores.find((s) => s.agentId === "ag-c");
    expect(score?.escalationLevel).toBe("critical");
  });

  it("fires onEscalation callback when escalating", () => {
    const escalated: EscalationRecord[] = [];
    const r = new NexusOrphanRecovery({
      onEscalation: (rec) => escalated.push(rec),
    });
    for (let i = 0; i < 5; i++) r.recordRunStart("ag-cb");
    for (let i = 0; i < 4; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-cb" }));
    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated.some((e) => e.agentId === "ag-cb")).toBe(true);
  });

  it("auto-resolves escalation when agent becomes healthy", () => {
    const resolved: { agentId: string; level: EscalationLevel }[] = [];
    const r = new NexusOrphanRecovery({
      healthWindowMs: 1, // 1ms window so old orphans expire immediately
      onEscalationResolved: (agentId, previousLevel) => resolved.push({ agentId, previousLevel }),
    });
    for (let i = 0; i < 5; i++) r.recordRunStart("ag-resolve");
    for (let i = 0; i < 4; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-resolve" }));
    // Now mark healthy — window has expired so orphan rate is 0
    r.markAgentHealthy("ag-resolve");
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved[0]!.agentId).toBe("ag-resolve");
  });

  it("configure() replaces onEscalation callback", () => {
    const firstCalls: string[] = [];
    const secondCalls: string[] = [];
    const r = new NexusOrphanRecovery({
      onEscalation: () => firstCalls.push("first"),
    });
    r.configure({ onEscalation: () => secondCalls.push("second") });
    for (let i = 0; i < 5; i++) r.recordRunStart("ag-cfg");
    for (let i = 0; i < 4; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-cfg" }));
    expect(firstCalls).toHaveLength(0);
    expect(secondCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// getSummary window timestamps
// ---------------------------------------------------------------------------

describe("NexusOrphanRecovery – getSummary", () => {
  it("windowEndAt is after windowStartAt", () => {
    const r = new NexusOrphanRecovery();
    const summary = r.getSummary();
    expect(summary.windowEndAt.getTime()).toBeGreaterThan(summary.windowStartAt.getTime());
  });

  it("agentHealthScores is an array", () => {
    const r = new NexusOrphanRecovery();
    r.recordRunStart("ag-s");
    const summary = r.getSummary();
    expect(Array.isArray(summary.agentHealthScores)).toBe(true);
  });

  it("escalations array reflects recorded escalations", () => {
    const r = new NexusOrphanRecovery();
    for (let i = 0; i < 5; i++) r.recordRunStart("ag-esc");
    for (let i = 0; i < 4; i++) r.recordOrphan(makeOrphanInput({ agentId: "ag-esc" }));
    const summary = r.getSummary();
    const esc = summary.escalations.find((e) => e.agentId === "ag-esc");
    expect(esc).toBeDefined();
    expect(["warning", "critical", "suspended"]).toContain(esc!.level);
  });
});
