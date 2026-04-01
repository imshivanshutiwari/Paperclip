import { eq } from "drizzle-orm";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";
import { describe, it, expect } from "vitest";
import {
  companyScope,
  agentSelfScope,
  companyAndCond,
  companyInScope,
  assertCompanyScope,
  makeBypassRls,
  makeRlsPolicy,
  withRlsAudit,
  getPolicyCompanyId,
  isScopedPolicy,
  RlsViolationError,
  type RlsPolicy,
  type RlsAuditEntry,
} from "./rls.js";

// ---------------------------------------------------------------------------
// Minimal Drizzle table fixtures (no DB connection needed)
// ---------------------------------------------------------------------------

const fakeTable = pgTable("fake_table", {
  id: uuid("id").primaryKey(),
  companyId: uuid("company_id").notNull(),
  agentId: uuid("agent_id"),
  name: text("name"),
});

function boardPolicy(companyId = "company-aaa"): RlsPolicy {
  return makeRlsPolicy({ companyId, actorType: "board", agentId: null });
}

function agentPolicy(companyId = "company-aaa", agentId = "agent-111"): RlsPolicy {
  return makeRlsPolicy({ companyId, actorType: "agent", agentId });
}

function bypassPolicy(): RlsPolicy {
  return makeBypassRls("admin migration", "migration-v1");
}

// ---------------------------------------------------------------------------
// makeRlsPolicy / makeBypassRls
// ---------------------------------------------------------------------------

describe("makeRlsPolicy", () => {
  it("creates a scoped policy", () => {
    const p = makeRlsPolicy({ companyId: "c1", actorType: "board", agentId: null });
    expect(p.type).toBe("scoped");
    if (p.type === "scoped") {
      expect(p.ctx.companyId).toBe("c1");
      expect(p.ctx.actorType).toBe("board");
    }
  });
});

describe("makeBypassRls", () => {
  it("creates a bypass policy with reason and tag", () => {
    const p = makeBypassRls("some reason", "tag-123");
    expect(p.type).toBe("bypass");
    if (p.type === "bypass") {
      expect(p.reason).toBe("some reason");
      expect(p.auditTag).toBe("tag-123");
    }
  });
});

// ---------------------------------------------------------------------------
// companyScope
// ---------------------------------------------------------------------------

describe("companyScope", () => {
  it("returns an SQL fragment for scoped policy", () => {
    const p = boardPolicy();
    const cond = companyScope(p, fakeTable.companyId);
    expect(cond).toBeDefined();
  });

  it("returns undefined for bypass policy", () => {
    const p = bypassPolicy();
    const cond = companyScope(p, fakeTable.companyId);
    expect(cond).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// agentSelfScope
// ---------------------------------------------------------------------------

describe("agentSelfScope", () => {
  it("returns a condition for agent actor", () => {
    const p = agentPolicy("company-aaa", "agent-111");
    const cond = agentSelfScope(p, fakeTable.companyId, fakeTable.agentId!);
    expect(cond).toBeDefined();
  });

  it("returns a condition for board actor", () => {
    const p = boardPolicy();
    const cond = agentSelfScope(p, fakeTable.companyId, fakeTable.agentId!);
    expect(cond).toBeDefined();
  });

  it("returns undefined for bypass policy", () => {
    const p = bypassPolicy();
    const cond = agentSelfScope(p, fakeTable.companyId, fakeTable.agentId!);
    expect(cond).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// companyAndCond
// ---------------------------------------------------------------------------

describe("companyAndCond", () => {
  it("returns scoped SQL when given a scoped policy", () => {
    const p = boardPolicy();
    const cond = companyAndCond(p, fakeTable.companyId);
    expect(cond).toBeDefined();
  });

  it("returns undefined for bypass policy with no additional conds", () => {
    const p = bypassPolicy();
    const cond = companyAndCond(p, fakeTable.companyId);
    expect(cond).toBeUndefined();
  });

  it("returns additional cond alone when bypass + 1 extra", () => {
    const p = bypassPolicy();
    const extra = eq(fakeTable.id, "some-id");
    const cond = companyAndCond(p, fakeTable.companyId, extra);
    expect(cond).toBeDefined();
  });

  it("returns AND of scope + extra when scoped + 1 extra", () => {
    const p = boardPolicy();
    const extra = eq(fakeTable.id, "some-id");
    const cond = companyAndCond(p, fakeTable.companyId, extra);
    expect(cond).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// companyInScope
// ---------------------------------------------------------------------------

describe("companyInScope", () => {
  it("returns undefined for empty array", () => {
    const cond = companyInScope([], fakeTable.companyId);
    expect(cond).toBeUndefined();
  });

  it("returns eq condition for single ID", () => {
    const cond = companyInScope(["c1"], fakeTable.companyId);
    expect(cond).toBeDefined();
  });

  it("returns inArray condition for multiple IDs", () => {
    const cond = companyInScope(["c1", "c2", "c3"], fakeTable.companyId);
    expect(cond).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// assertCompanyScope
// ---------------------------------------------------------------------------

describe("assertCompanyScope", () => {
  it("passes when companyId matches policy", () => {
    const p = boardPolicy("company-aaa");
    expect(() => assertCompanyScope(p, "company-aaa", "test.op")).not.toThrow();
  });

  it("throws RlsViolationError when companyId mismatches", () => {
    const p = boardPolicy("company-aaa");
    expect(() => assertCompanyScope(p, "company-bbb", "test.op")).toThrow(RlsViolationError);
  });

  it("throws with informative message", () => {
    const p = boardPolicy("company-aaa");
    expect(() => assertCompanyScope(p, "company-bbb", "issues.get")).toThrowError(/company scope violation/i);
  });

  it("does not throw for bypass policy regardless of companyId", () => {
    const p = bypassPolicy();
    expect(() => assertCompanyScope(p, "any-company", "test.op")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// withRlsAudit
// ---------------------------------------------------------------------------

describe("withRlsAudit", () => {
  it("calls the logger with correct fields for scoped policy", async () => {
    const entries: RlsAuditEntry[] = [];
    const p = boardPolicy("company-z");
    const result = await withRlsAudit(p, "myService.list", (e) => entries.push(e), async () => 42);
    expect(result).toBe(42);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.bypass).toBe(false);
    expect(entries[0]!.companyId).toBe("company-z");
    expect(entries[0]!.operation).toBe("myService.list");
    expect(entries[0]!.actorType).toBe("board");
  });

  it("calls the logger with bypass fields for bypass policy", async () => {
    const entries: RlsAuditEntry[] = [];
    const p = bypassPolicy();
    await withRlsAudit(p, "admin.migrate", (e) => entries.push(e), async () => "ok");
    expect(entries[0]!.bypass).toBe(true);
    expect(entries[0]!.bypassReason).toBe("admin migration");
    expect(entries[0]!.bypassTag).toBe("migration-v1");
    expect(entries[0]!.companyId).toBeNull();
  });

  it("propagates errors from the wrapped function", async () => {
    const p = boardPolicy();
    await expect(
      withRlsAudit(p, "op", () => {}, async () => { throw new Error("db down"); }),
    ).rejects.toThrow("db down");
  });
});

// ---------------------------------------------------------------------------
// getPolicyCompanyId / isScopedPolicy
// ---------------------------------------------------------------------------

describe("getPolicyCompanyId", () => {
  it("returns companyId for scoped policy", () => {
    const p = boardPolicy("company-xyz");
    expect(getPolicyCompanyId(p)).toBe("company-xyz");
  });

  it("returns null for bypass policy", () => {
    const p = bypassPolicy();
    expect(getPolicyCompanyId(p)).toBeNull();
  });
});

describe("isScopedPolicy", () => {
  it("returns true for scoped policy", () => {
    expect(isScopedPolicy(boardPolicy())).toBe(true);
  });

  it("returns false for bypass policy", () => {
    expect(isScopedPolicy(bypassPolicy())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RlsViolationError
// ---------------------------------------------------------------------------

describe("RlsViolationError", () => {
  it("has name RlsViolationError", () => {
    const err = new RlsViolationError("oops");
    expect(err.name).toBe("RlsViolationError");
  });

  it("is instanceof Error", () => {
    const err = new RlsViolationError("oops");
    expect(err).toBeInstanceOf(Error);
  });

  it("is instanceof RlsViolationError", () => {
    const err = new RlsViolationError("oops");
    expect(err).toBeInstanceOf(RlsViolationError);
  });
});
