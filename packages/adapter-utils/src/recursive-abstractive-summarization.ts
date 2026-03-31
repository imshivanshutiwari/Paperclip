/**
 * NexusAI Recursive Abstractive Summarization (RAS)
 *
 * Upgrades session context management from simple token-count trimming to a
 * multi-level recursive summarization strategy that supports theoretically
 * unbounded session histories.
 *
 * Architecture:
 *   Level 0 – Raw run transcript (full fidelity, kept for N most-recent runs)
 *   Level 1 – Per-run abstractive digest (key decisions, outputs, file changes)
 *   Level 2 – Cross-run rolling summary (recent N level-1 digests merged)
 *   Level 3 – Long-horizon abstract (periodically collapsed from level-2 chunks)
 *
 * At inference time the agent receives: level-0 (most recent K runs) +
 * level-1 (next M runs) + level-2 rolling + level-3 abstract. This gives
 * high fidelity for recent work and compressed context for older history,
 * enabling infinite-horizon sessions without hitting token limits.
 *
 * @module recursive-abstractive-summarization
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Granularity level in the RAS hierarchy.
 *
 *   0 = raw transcript (full tokens)
 *   1 = per-run digest
 *   2 = rolling cross-run summary
 *   3 = long-horizon abstract
 */
export type SummarizationLevel = 0 | 1 | 2 | 3;

export interface SummarizationTier {
  level: SummarizationLevel;
  /** How many items at this level to keep before collapsing to the next. */
  retentionCount: number;
  /** Approximate token budget for this tier's context injection. */
  tokenBudget: number;
}

/**
 * Full multi-tier RAS configuration for a session.
 *
 * Tiers MUST be ordered level 0 → 3. Lower levels hold fresher content at
 * higher fidelity; higher levels hold older content at lower fidelity.
 */
export interface RecursiveAbstractiveSummarizationPolicy {
  enabled: boolean;
  tiers: [SummarizationTier, SummarizationTier, SummarizationTier, SummarizationTier];
  /**
   * When `true`, the system attempts to collapse level-2 summaries into a
   * level-3 abstract when the level-2 count exceeds the tier's retentionCount.
   * Requires an LLM abstraction call; set `false` for offline-safe behaviour.
   */
  enableLevel3Collapse: boolean;
  /** Soft cap on total tokens injected across all tiers. */
  globalTokenBudget: number;
}

/**
 * A single summarization unit produced at a given level.
 */
export interface SummarizationUnit {
  level: SummarizationLevel;
  /** Ordered index within the level (0 = oldest). */
  index: number;
  /** Run IDs that were collapsed into this unit. */
  sourceRunIds: string[];
  /** Approximate token count for this unit. */
  estimatedTokens: number;
  /** The summarized content. */
  content: string;
  createdAt: Date;
}

/**
 * The assembled context payload ready for injection into an agent prompt.
 */
export interface RasContextPayload {
  units: SummarizationUnit[];
  totalEstimatedTokens: number;
  tierBreakdown: Record<SummarizationLevel, number>;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Default policies
// ---------------------------------------------------------------------------

/**
 * Default RAS policy used when no override is specified. Provides a balanced
 * configuration suitable for most agent session types.
 */
export const DEFAULT_RAS_POLICY: RecursiveAbstractiveSummarizationPolicy = {
  enabled: true,
  tiers: [
    { level: 0, retentionCount: 3,  tokenBudget: 16_000 }, // Last 3 runs, raw
    { level: 1, retentionCount: 10, tokenBudget: 8_000  }, // Next 10 runs, digest
    { level: 2, retentionCount: 5,  tokenBudget: 4_000  }, // Last 5 cross-run summaries
    { level: 3, retentionCount: 1,  tokenBudget: 2_000  }, // Long-horizon abstract
  ],
  enableLevel3Collapse: false, // Safe default – no LLM call required
  globalTokenBudget: 28_000,
};

/**
 * Conservative policy for adapters with native context management. Retains a
 * minimal digest rather than full raw history.
 */
export const MINIMAL_RAS_POLICY: RecursiveAbstractiveSummarizationPolicy = {
  enabled: true,
  tiers: [
    { level: 0, retentionCount: 1,  tokenBudget: 4_000 },
    { level: 1, retentionCount: 5,  tokenBudget: 2_000 },
    { level: 2, retentionCount: 2,  tokenBudget: 1_000 },
    { level: 3, retentionCount: 1,  tokenBudget: 500   },
  ],
  enableLevel3Collapse: false,
  globalTokenBudget: 7_000,
};

/**
 * Aggressive policy for long-running research or engineering sessions where
 * deep history matters.
 */
export const DEEP_HISTORY_RAS_POLICY: RecursiveAbstractiveSummarizationPolicy = {
  enabled: true,
  tiers: [
    { level: 0, retentionCount: 5,  tokenBudget: 40_000 },
    { level: 1, retentionCount: 20, tokenBudget: 20_000 },
    { level: 2, retentionCount: 10, tokenBudget: 10_000 },
    { level: 3, retentionCount: 3,  tokenBudget: 5_000  },
  ],
  enableLevel3Collapse: true,
  globalTokenBudget: 70_000,
};

// ---------------------------------------------------------------------------
// Context assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a context payload from a flat ordered list of `SummarizationUnit`s
 * according to the given `policy`.
 *
 * Algorithm:
 *   1. Partition units by level.
 *   2. For each tier, take the most recent `retentionCount` units.
 *   3. Enforce per-tier token budgets, dropping oldest units first.
 *   4. Enforce the global token budget, trimming level-2/3 first.
 *   5. Return the assembled payload with tier breakdown and truncation flag.
 */
export function assembleRasContext(
  units: SummarizationUnit[],
  policy: RecursiveAbstractiveSummarizationPolicy,
): RasContextPayload {
  if (!policy.enabled) {
    return {
      units: [],
      totalEstimatedTokens: 0,
      tierBreakdown: { 0: 0, 1: 0, 2: 0, 3: 0 },
      truncated: false,
    };
  }

  const byLevel = partitionByLevel(units);
  const selected: SummarizationUnit[] = [];
  const breakdown: Record<SummarizationLevel, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let truncated = false;

  for (const tier of policy.tiers) {
    const levelUnits = byLevel[tier.level] ?? [];
    // Most recent N units
    const candidates = levelUnits.slice(-tier.retentionCount);
    // Enforce per-tier token budget
    let tierTokens = 0;
    const tierSelected: SummarizationUnit[] = [];
    // Iterate newest-first to prioritise recent content
    for (let i = candidates.length - 1; i >= 0; i--) {
      const unit = candidates[i]!;
      if (tierTokens + unit.estimatedTokens <= tier.tokenBudget) {
        tierSelected.unshift(unit);
        tierTokens += unit.estimatedTokens;
      } else {
        truncated = true;
      }
    }
    selected.push(...tierSelected);
    breakdown[tier.level] = tierTokens;
  }

  // Enforce global budget: trim from highest level first
  let total = selected.reduce((s, u) => s + u.estimatedTokens, 0);
  if (total > policy.globalTokenBudget) {
    truncated = true;
    // Drop from level 3 first, then 2, then 1 – never drop level 0
    for (const dropLevel of [3, 2, 1] as const) {
      while (total > policy.globalTokenBudget) {
        const idx = selected.findIndex((u) => u.level === dropLevel);
        if (idx === -1) break;
        total -= selected[idx]!.estimatedTokens;
        breakdown[dropLevel] -= selected[idx]!.estimatedTokens;
        selected.splice(idx, 1);
      }
      if (total <= policy.globalTokenBudget) break;
    }
  }

  return {
    units: selected,
    totalEstimatedTokens: total,
    tierBreakdown: breakdown,
    truncated,
  };
}

// ---------------------------------------------------------------------------
// Level detection helpers
// ---------------------------------------------------------------------------

/**
 * Determine the appropriate summarization level for a new run's output based
 * on the current state of the session history. Used by the heartbeat service
 * when recording run completions.
 */
export function resolveRunSummarizationLevel(
  sessionRunCount: number,
  policy: RecursiveAbstractiveSummarizationPolicy,
): SummarizationLevel {
  // Runs within the raw tier window get level-0
  const rawRetention = policy.tiers[0].retentionCount;
  if (sessionRunCount <= rawRetention) return 0;

  // Runs within the level-1 window get a digest
  const level1Retention = policy.tiers[1].retentionCount;
  if (sessionRunCount <= rawRetention + level1Retention) return 1;

  // Older runs produce level-2 rolling summaries
  return 2;
}

/**
 * Determine whether the current session should trigger a level-3 collapse.
 * Returns `true` when level-2 units exceed the tier retention count and
 * collapse is enabled.
 */
export function shouldTriggerLevel3Collapse(
  level2Units: number,
  policy: RecursiveAbstractiveSummarizationPolicy,
): boolean {
  return (
    policy.enableLevel3Collapse &&
    level2Units > policy.tiers[2].retentionCount
  );
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Rough token count estimator for a string (assumes ~4 chars/token for English
 * code/prose). Precise tokenisation is adapter-specific; this gives a fast
 * budget estimate without requiring a tokeniser import.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Policy parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw `Record<string, unknown>` runtime-config blob into a full
 * `RecursiveAbstractiveSummarizationPolicy`. Falls back to `DEFAULT_RAS_POLICY`
 * for any missing or invalid fields – never throws.
 */
export function parseRasPolicy(
  runtimeConfig: unknown,
  fallback: RecursiveAbstractiveSummarizationPolicy = DEFAULT_RAS_POLICY,
): RecursiveAbstractiveSummarizationPolicy {
  if (!isRecord(runtimeConfig)) return fallback;
  const ras = isRecord(runtimeConfig["ras"]) ? runtimeConfig["ras"] : null;
  if (!ras) return fallback;

  const enabled = readBool(ras["enabled"], fallback.enabled);
  const globalTokenBudget = readPositiveInt(ras["globalTokenBudget"], fallback.globalTokenBudget);
  const enableLevel3Collapse = readBool(ras["enableLevel3Collapse"], fallback.enableLevel3Collapse);

  return {
    enabled,
    globalTokenBudget,
    enableLevel3Collapse,
    tiers: fallback.tiers, // Tier overrides not exposed via runtime config
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function partitionByLevel(units: SummarizationUnit[]): Record<SummarizationLevel, SummarizationUnit[]> {
  const result: Record<SummarizationLevel, SummarizationUnit[]> = { 0: [], 1: [], 2: [], 3: [] };
  for (const unit of units) {
    result[unit.level].push(unit);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}
