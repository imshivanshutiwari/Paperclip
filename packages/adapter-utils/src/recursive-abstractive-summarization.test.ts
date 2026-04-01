import { describe, it, expect } from "vitest";
import {
  assembleRasContext,
  resolveRunSummarizationLevel,
  shouldTriggerLevel3Collapse,
  estimateTokens,
  parseRasPolicy,
  DEFAULT_RAS_POLICY,
  MINIMAL_RAS_POLICY,
  DEEP_HISTORY_RAS_POLICY,
  type SummarizationUnit,
  type RecursiveAbstractiveSummarizationPolicy,
} from "./recursive-abstractive-summarization.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeUnit(
  level: SummarizationUnit["level"],
  estimatedTokens: number,
  overrides: Partial<SummarizationUnit> = {},
): SummarizationUnit {
  _seq++;
  return {
    level,
    index: _seq,
    sourceRunIds: [`run-${_seq}`],
    estimatedTokens,
    content: `content-${_seq}`,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns ceil(length/4)", () => {
    expect(estimateTokens("abcd")).toBe(1);   // 4 chars → 1 token
    expect(estimateTokens("abcde")).toBe(2);  // 5 chars → ceil(5/4)=2
    expect(estimateTokens("abc")).toBe(1);    // 3 chars → ceil(3/4)=1
  });

  it("handles longer strings", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// resolveRunSummarizationLevel
// ---------------------------------------------------------------------------

describe("resolveRunSummarizationLevel", () => {
  it("returns 0 for runs within the raw retention window", () => {
    // DEFAULT_RAS_POLICY: level-0 retentionCount = 3
    expect(resolveRunSummarizationLevel(1, DEFAULT_RAS_POLICY)).toBe(0);
    expect(resolveRunSummarizationLevel(3, DEFAULT_RAS_POLICY)).toBe(0);
  });

  it("returns 1 for runs in the level-1 window", () => {
    // level-0 retention = 3, level-1 retention = 10 → runs 4-13 get level-1
    expect(resolveRunSummarizationLevel(4, DEFAULT_RAS_POLICY)).toBe(1);
    expect(resolveRunSummarizationLevel(13, DEFAULT_RAS_POLICY)).toBe(1);
  });

  it("returns 2 for runs beyond level-1 window", () => {
    // runs > 13 get level-2
    expect(resolveRunSummarizationLevel(14, DEFAULT_RAS_POLICY)).toBe(2);
    expect(resolveRunSummarizationLevel(100, DEFAULT_RAS_POLICY)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// shouldTriggerLevel3Collapse
// ---------------------------------------------------------------------------

describe("shouldTriggerLevel3Collapse", () => {
  it("returns false when collapse is disabled", () => {
    // DEFAULT_RAS_POLICY has enableLevel3Collapse = false
    expect(shouldTriggerLevel3Collapse(10, DEFAULT_RAS_POLICY)).toBe(false);
  });

  it("returns false when level-2 count is within retention", () => {
    // DEEP_HISTORY_RAS_POLICY has enableLevel3Collapse = true, level-2 retentionCount = 10
    expect(shouldTriggerLevel3Collapse(9, DEEP_HISTORY_RAS_POLICY)).toBe(false);
    expect(shouldTriggerLevel3Collapse(10, DEEP_HISTORY_RAS_POLICY)).toBe(false);
  });

  it("returns true when level-2 count exceeds retention and collapse enabled", () => {
    // level-2 retentionCount = 10
    expect(shouldTriggerLevel3Collapse(11, DEEP_HISTORY_RAS_POLICY)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assembleRasContext – disabled policy
// ---------------------------------------------------------------------------

describe("assembleRasContext – disabled policy", () => {
  it("returns empty payload when policy.enabled is false", () => {
    const disabled: RecursiveAbstractiveSummarizationPolicy = { ...DEFAULT_RAS_POLICY, enabled: false };
    const units = [makeUnit(0, 100), makeUnit(1, 200)];
    const result = assembleRasContext(units, disabled);
    expect(result.units).toHaveLength(0);
    expect(result.totalEstimatedTokens).toBe(0);
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assembleRasContext – basic selection
// ---------------------------------------------------------------------------

describe("assembleRasContext – basic selection", () => {
  it("selects units up to tier retention limits", () => {
    // Policy: only keep 2 level-0 and 1 level-1
    const policy: RecursiveAbstractiveSummarizationPolicy = {
      enabled: true,
      tiers: [
        { level: 0, retentionCount: 2, tokenBudget: 10_000 },
        { level: 1, retentionCount: 1, tokenBudget: 10_000 },
        { level: 2, retentionCount: 1, tokenBudget: 10_000 },
        { level: 3, retentionCount: 1, tokenBudget: 10_000 },
      ],
      enableLevel3Collapse: false,
      globalTokenBudget: 100_000,
    };

    const units = [
      makeUnit(0, 100), makeUnit(0, 100), makeUnit(0, 100), // 3 level-0, only 2 should be kept
      makeUnit(1, 200), makeUnit(1, 200),                   // 2 level-1, only 1 should be kept
    ];
    const result = assembleRasContext(units, policy);
    const level0Count = result.units.filter((u) => u.level === 0).length;
    const level1Count = result.units.filter((u) => u.level === 1).length;
    expect(level0Count).toBe(2);
    expect(level1Count).toBe(1);
  });

  it("returns all units when within all budgets", () => {
    const units = [makeUnit(0, 50), makeUnit(1, 50), makeUnit(2, 50)];
    const result = assembleRasContext(units, DEFAULT_RAS_POLICY);
    expect(result.units.length).toBeGreaterThanOrEqual(3);
    expect(result.truncated).toBe(false);
  });

  it("computes correct totalEstimatedTokens", () => {
    const units = [makeUnit(0, 100), makeUnit(0, 200), makeUnit(1, 300)];
    const result = assembleRasContext(units, DEFAULT_RAS_POLICY);
    const expectedTotal = result.units.reduce((s, u) => s + u.estimatedTokens, 0);
    expect(result.totalEstimatedTokens).toBe(expectedTotal);
  });
});

// ---------------------------------------------------------------------------
// assembleRasContext – per-tier token budget
// ---------------------------------------------------------------------------

describe("assembleRasContext – per-tier token budget", () => {
  it("drops oldest units when tier token budget is exceeded", () => {
    const policy: RecursiveAbstractiveSummarizationPolicy = {
      enabled: true,
      tiers: [
        { level: 0, retentionCount: 10, tokenBudget: 150 }, // budget only fits 1 × 100-token unit
        { level: 1, retentionCount: 10, tokenBudget: 10_000 },
        { level: 2, retentionCount: 10, tokenBudget: 10_000 },
        { level: 3, retentionCount: 10, tokenBudget: 10_000 },
      ],
      enableLevel3Collapse: false,
      globalTokenBudget: 1_000_000,
    };
    const units = [makeUnit(0, 100), makeUnit(0, 100)]; // 2 units, total 200 > budget 150
    const result = assembleRasContext(units, policy);
    expect(result.truncated).toBe(true);
    const level0 = result.units.filter((u) => u.level === 0);
    expect(level0.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// assembleRasContext – global token budget
// ---------------------------------------------------------------------------

describe("assembleRasContext – global token budget", () => {
  it("enforces global budget by dropping higher-level units first", () => {
    const policy: RecursiveAbstractiveSummarizationPolicy = {
      enabled: true,
      tiers: [
        { level: 0, retentionCount: 5, tokenBudget: 5_000 },
        { level: 1, retentionCount: 5, tokenBudget: 5_000 },
        { level: 2, retentionCount: 5, tokenBudget: 5_000 },
        { level: 3, retentionCount: 5, tokenBudget: 5_000 },
      ],
      enableLevel3Collapse: false,
      globalTokenBudget: 400, // very tight: only ~4 × 100-token units
    };
    const units = [
      makeUnit(0, 100), makeUnit(0, 100),
      makeUnit(1, 100), makeUnit(1, 100),
      makeUnit(2, 100), makeUnit(3, 100),
    ];
    const result = assembleRasContext(units, policy);
    expect(result.truncated).toBe(true);
    expect(result.totalEstimatedTokens).toBeLessThanOrEqual(400);
    // Level-0 units must be preserved (they are the highest priority)
    const level0 = result.units.filter((u) => u.level === 0);
    expect(level0.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// assembleRasContext – tierBreakdown
// ---------------------------------------------------------------------------

describe("assembleRasContext – tierBreakdown", () => {
  it("includes all 4 tier keys", () => {
    const result = assembleRasContext([], DEFAULT_RAS_POLICY);
    expect(Object.keys(result.tierBreakdown).sort()).toEqual(["0", "1", "2", "3"]);
  });

  it("records per-tier token totals correctly", () => {
    const units = [makeUnit(0, 80), makeUnit(0, 70), makeUnit(1, 90)];
    const result = assembleRasContext(units, DEFAULT_RAS_POLICY);
    expect(result.tierBreakdown[0]).toBe(80 + 70);
    expect(result.tierBreakdown[1]).toBe(90);
    expect(result.tierBreakdown[2]).toBe(0);
    expect(result.tierBreakdown[3]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseRasPolicy
// ---------------------------------------------------------------------------

describe("parseRasPolicy", () => {
  it("returns fallback for null input", () => {
    expect(parseRasPolicy(null)).toBe(DEFAULT_RAS_POLICY);
  });

  it("returns fallback for non-object input", () => {
    expect(parseRasPolicy("bad")).toBe(DEFAULT_RAS_POLICY);
    expect(parseRasPolicy(42)).toBe(DEFAULT_RAS_POLICY);
  });

  it("returns fallback when no 'ras' key", () => {
    expect(parseRasPolicy({ other: true })).toBe(DEFAULT_RAS_POLICY);
  });

  it("applies enabled=false override", () => {
    const result = parseRasPolicy({ ras: { enabled: false } });
    expect(result.enabled).toBe(false);
    expect(result.globalTokenBudget).toBe(DEFAULT_RAS_POLICY.globalTokenBudget);
  });

  it("applies globalTokenBudget override", () => {
    const result = parseRasPolicy({ ras: { globalTokenBudget: 99_000 } });
    expect(result.globalTokenBudget).toBe(99_000);
  });

  it("applies enableLevel3Collapse override", () => {
    const result = parseRasPolicy({ ras: { enableLevel3Collapse: true } });
    expect(result.enableLevel3Collapse).toBe(true);
  });

  it("ignores non-positive globalTokenBudget and keeps fallback", () => {
    const result = parseRasPolicy({ ras: { globalTokenBudget: -100 } });
    expect(result.globalTokenBudget).toBe(DEFAULT_RAS_POLICY.globalTokenBudget);
  });

  it("uses provided fallback policy", () => {
    const result = parseRasPolicy(null, MINIMAL_RAS_POLICY);
    expect(result).toBe(MINIMAL_RAS_POLICY);
  });
});

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

describe("policy constants", () => {
  it("DEFAULT_RAS_POLICY has 4 tiers in order", () => {
    expect(DEFAULT_RAS_POLICY.tiers.map((t) => t.level)).toEqual([0, 1, 2, 3]);
  });

  it("MINIMAL_RAS_POLICY has 4 tiers in order", () => {
    expect(MINIMAL_RAS_POLICY.tiers.map((t) => t.level)).toEqual([0, 1, 2, 3]);
  });

  it("DEEP_HISTORY_RAS_POLICY has enableLevel3Collapse=true", () => {
    expect(DEEP_HISTORY_RAS_POLICY.enableLevel3Collapse).toBe(true);
  });
});
