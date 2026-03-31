/**
 * NexusAI Row-Level Security (RLS) Pattern Utilities
 *
 * Provides type-safe, composable helpers for enforcing multi-tenancy at the
 * query layer. Every data access to company-scoped tables MUST go through one
 * of these helpers so that company isolation is guaranteed by construction
 * rather than convention.
 *
 * Design principles:
 *   - Zero `any` types – all helpers are fully generic over Drizzle table types.
 *   - Composable: helpers return Drizzle `SQL` fragments that can be AND-ed into
 *     any existing `where` clause.
 *   - Explicit opt-out: cross-company admin operations must pass `BypassRls`
 *     explicitly, making them visible in code review.
 *   - Audit-friendly: every bypass is logged via the `withRlsAudit` wrapper.
 *
 * @module rls
 */

import { and, eq, inArray, type SQL } from "drizzle-orm";
import { type PgColumn, type PgTable } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A token that must be passed explicitly to bypass RLS checks. Keeping this
 * opaque makes accidental bypasses easy to spot via static analysis / code
 * review.
 */
export type BypassRls = typeof BYPASS_RLS_TOKEN;

/**
 * Describes the resolved access context for a single request. Used to carry
 * company-scope information through service boundaries without relying on
 * thread-local / AsyncLocalStorage globals.
 */
export interface RlsContext {
  /** The resolved company ID for this request. */
  companyId: string;
  /**
   * Actor type – determines which additional checks are applied.
   *   - `"board"`: human operator via UI session
   *   - `"agent"`: automated agent via API key
   *   - `"system"`: internal server-to-server call (treated like board)
   */
  actorType: "board" | "agent" | "system";
  /** For agent actors: the agent's own ID. Null for board/system. */
  agentId: string | null;
}

/**
 * A multi-tenant access policy descriptor attached to a query. Carry this
 * through your call stack so that helpers can enforce consistent isolation.
 */
export type RlsPolicy =
  | { type: "scoped"; ctx: RlsContext }
  | { type: "bypass"; reason: string; auditTag: string };

// ---------------------------------------------------------------------------
// Bypass token (opaque symbol)
// ---------------------------------------------------------------------------

/** @internal Use `makeBypassRls()` to obtain a token. */
const BYPASS_RLS_TOKEN = Symbol("nexusai.rls.bypass");

/**
 * Create an RLS bypass policy. Must be accompanied by an audit tag and reason
 * for code-review traceability.
 *
 * @param reason   - Human-readable reason for the bypass.
 * @param auditTag - Short stable tag used in audit logs (e.g. `"migration-v3"`).
 */
export function makeBypassRls(reason: string, auditTag: string): RlsPolicy {
  return { type: "bypass", reason, auditTag };
}

/**
 * Create a company-scoped RLS policy for an inbound request.
 *
 * @param ctx - The resolved request context.
 */
export function makeRlsPolicy(ctx: RlsContext): RlsPolicy {
  return { type: "scoped", ctx };
}

// ---------------------------------------------------------------------------
// Core predicate builder
// ---------------------------------------------------------------------------

/**
 * Build a Drizzle `SQL` fragment that constrains a query to the company ID
 * carried in `policy`. Returns `undefined` for bypass policies so that callers
 * can spread the result into `.where()` without additional branching.
 *
 * @example
 * ```ts
 * const filter = companyScope(policy, agents.companyId);
 * const rows = await db.select().from(agents).where(filter);
 * ```
 */
export function companyScope(
  policy: RlsPolicy,
  companyIdColumn: PgColumn,
): SQL | undefined {
  if (policy.type === "bypass") return undefined;
  return eq(companyIdColumn, policy.ctx.companyId);
}

/**
 * Variant of `companyScope` that also restricts to a specific agent's own row
 * when the actor type is `"agent"`. Useful for agent-owned resource reads (e.g.
 * an agent reading its own config).
 */
export function agentSelfScope(
  policy: RlsPolicy,
  companyIdColumn: PgColumn,
  agentIdColumn: PgColumn,
): SQL | undefined {
  if (policy.type === "bypass") return undefined;
  const companyCond = eq(companyIdColumn, policy.ctx.companyId);
  if (policy.ctx.actorType === "agent" && policy.ctx.agentId) {
    return and(companyCond, eq(agentIdColumn, policy.ctx.agentId));
  }
  return companyCond;
}

/**
 * Build a compound condition for queries against tables that store a direct
 * `id` or `company_id`. Merges the company scope with any additional caller-
 * supplied conditions.
 *
 * @example
 * ```ts
 * const cond = companyAndCond(policy, issues.companyId, eq(issues.id, issueId));
 * ```
 */
export function companyAndCond(
  policy: RlsPolicy,
  companyIdColumn: PgColumn,
  ...additional: Array<SQL | undefined>
): SQL | undefined {
  const scope = companyScope(policy, companyIdColumn);
  const others = additional.filter((c): c is SQL => c !== undefined);

  if (!scope && others.length === 0) return undefined;
  if (!scope) return others.length === 1 ? others[0] : and(...others as [SQL, SQL, ...SQL[]]);
  if (others.length === 0) return scope;
  return and(scope, ...others as [SQL, ...SQL[]]);
}

/**
 * Restrict a query to a set of company IDs (for cross-company admin queries
 * that are scoped to an explicit allowlist rather than a single company).
 */
export function companyInScope(
  companyIds: string[],
  companyIdColumn: PgColumn,
): SQL | undefined {
  if (companyIds.length === 0) return undefined;
  if (companyIds.length === 1) return eq(companyIdColumn, companyIds[0]!);
  return inArray(companyIdColumn, companyIds);
}

// ---------------------------------------------------------------------------
// Table-level RLS guard
// ---------------------------------------------------------------------------

/**
 * Interface for tables that participate in NexusAI RLS enforcement.
 * Implementing this interface on schema objects allows `assertCompanyScope`
 * to be used without knowing the specific column layout.
 */
export interface CompanyScopedTable extends PgTable {
  companyId: PgColumn;
}

/**
 * Validate at runtime that the provided `companyId` value matches the policy's
 * resolved company. Throws `RlsViolationError` for mismatches (guards against
 * programmer errors where a caller passes the wrong ID).
 *
 * Use this in service methods that accept an explicit `companyId` parameter to
 * ensure the caller isn't cross-contaminating data between tenants.
 *
 * @example
 * ```ts
 * assertCompanyScope(policy, inputCompanyId, "issueService.get");
 * ```
 */
export function assertCompanyScope(
  policy: RlsPolicy,
  companyId: string,
  operationTag: string,
): void {
  if (policy.type === "bypass") return;
  if (policy.ctx.companyId !== companyId) {
    throw new RlsViolationError(
      `Company scope violation in ${operationTag}: ` +
      `policy.companyId=${policy.ctx.companyId} but requested companyId=${companyId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Audit wrapper
// ---------------------------------------------------------------------------

export interface RlsAuditEntry {
  operation: string;
  policy: RlsPolicy;
  companyId: string | null;
  actorType: string;
  bypass: boolean;
  bypassReason: string | null;
  bypassTag: string | null;
  timestamp: Date;
}

export type RlsAuditLogger = (entry: RlsAuditEntry) => void;

/**
 * Wrap an async database operation with RLS audit logging. Logs every call
 * whether scoped or bypassed, enabling offline security analysis.
 *
 * @example
 * ```ts
 * const result = await withRlsAudit(policy, "issues.get", auditLogger, () =>
 *   db.select().from(issues).where(companyScope(policy, issues.companyId)),
 * );
 * ```
 */
export async function withRlsAudit<T>(
  policy: RlsPolicy,
  operation: string,
  logger: RlsAuditLogger,
  fn: () => Promise<T>,
): Promise<T> {
  const bypass = policy.type === "bypass";
  logger({
    operation,
    policy,
    companyId: bypass ? null : policy.ctx.companyId,
    actorType: bypass ? "system" : policy.ctx.actorType,
    bypass,
    bypassReason: bypass ? policy.reason : null,
    bypassTag: bypass ? policy.auditTag : null,
    timestamp: new Date(),
  });
  return fn();
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class RlsViolationError extends Error {
  override name = "RlsViolationError";

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Utility: extract company ID from a policy (safe accessor)
// ---------------------------------------------------------------------------

/**
 * Extract the `companyId` from a scoped policy, or return `null` for bypass
 * policies. Useful when you need the raw ID for logging but don't want to
 * throw on bypass.
 */
export function getPolicyCompanyId(policy: RlsPolicy): string | null {
  return policy.type === "scoped" ? policy.ctx.companyId : null;
}

/**
 * Type-guard: returns `true` if this policy represents a company-scoped
 * (non-bypass) request.
 */
export function isScopedPolicy(policy: RlsPolicy): policy is Extract<RlsPolicy, { type: "scoped" }> {
  return policy.type === "scoped";
}
