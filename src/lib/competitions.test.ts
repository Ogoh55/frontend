import { describe, expect, it } from "vitest";
import {
  annotateTies,
  antiGamingRules,
  canRegister,
  displayNameFor,
  formatInstant,
  formatPercentReturn,
  formatRank,
  formatScore,
  formatSignedUsd,
  hasDisplayName,
  pageCount,
  phaseOf,
  prizeTierForRank,
  registrationWindowOf,
  scoringMethodLabel,
  totalPrizePool,
  truncateAddress,
  validateCompetitionConfig,
} from "./competitions";
import { makeConfig, makeEntry } from "../test/fixtures";

const START = Date.parse("2026-10-01T00:00:00Z");
const END = Date.parse("2026-10-15T00:00:00Z");

describe("phaseOf", () => {
  const config = makeConfig();

  it("is upcoming before the start instant", () => {
    expect(phaseOf(config, START - 1)).toBe("upcoming");
  });

  it("is active at the exact start instant (boundary is half-open)", () => {
    expect(phaseOf(config, START)).toBe("active");
  });

  it("is active during the window", () => {
    expect(phaseOf(config, START + 86_400_000)).toBe("active");
  });

  it("is ended at the exact end instant", () => {
    expect(phaseOf(config, END)).toBe("ended");
    expect(phaseOf(config, END + 1)).toBe("ended");
  });

  it("uses absolute instants, so a DST transition cannot move the boundary", () => {
    // US clocks fall back at 02:00 local on 2026-11-01 (06:00Z). A wall-clock
    // implementation would make the window watch an hour too long or short.
    const dst = makeConfig({
      starts_at: "2026-11-01T04:00:00Z",
      ends_at: "2026-11-01T08:00:00Z",
    });
    expect(phaseOf(dst, Date.parse("2026-11-01T05:59:00Z"))).toBe("active");
    expect(phaseOf(dst, Date.parse("2026-11-01T06:01:00Z"))).toBe("active");
    expect(phaseOf(dst, Date.parse("2026-11-01T07:59:00Z"))).toBe("active");
    expect(phaseOf(dst, Date.parse("2026-11-01T08:00:00Z"))).toBe("ended");
  });

  it("accepts an offset-qualified instant and treats it as the same point in time", () => {
    const offset = makeConfig({
      starts_at: "2026-03-08T01:30:00-05:00", // 06:30Z
      ends_at: "2026-03-09T01:30:00-05:00",
    });
    expect(phaseOf(offset, Date.parse("2026-03-08T06:00:00Z"))).toBe("upcoming");
    expect(phaseOf(offset, Date.parse("2026-03-08T07:00:00Z"))).toBe("active");
  });

  it("throws rather than guessing when the config has no usable dates", () => {
    expect(() => phaseOf(makeConfig({ starts_at: "soon" }), START)).toThrow(RangeError);
  });
});

describe("registrationWindowOf", () => {
  it("defaults to closing at the start when registration_closes_at is absent", () => {
    const rest = makeConfig();
    delete rest.registration_closes_at;
    expect(registrationWindowOf(rest, START - 1)).toBe("open");
    expect(registrationWindowOf(rest, START)).toBe("closed");
    expect(registrationWindowOf(rest, END)).toBe("ended");
    expect(canRegister(rest, START)).toBe(false);
  });

  it("stays open until the end when registration_closes_at is explicitly null", () => {
    const config = makeConfig({ registration_closes_at: null });
    expect(registrationWindowOf(config, START + 86_400_000)).toBe("open");
    expect(registrationWindowOf(config, END - 1)).toBe("open");
    expect(registrationWindowOf(config, END)).toBe("ended");
  });

  it("honours an explicit close instant after the start", () => {
    const config = makeConfig({ registration_closes_at: "2026-10-08T00:00:00Z" });
    expect(registrationWindowOf(config, START + 86_400_000)).toBe("open");
    expect(registrationWindowOf(config, Date.parse("2026-10-09T00:00:00Z"))).toBe("closed");
  });
});

describe("validateCompetitionConfig", () => {
  it("accepts a well-formed config and normalises the prize tiers", () => {
    const result = validateCompetitionConfig(makeConfig({ prize_tiers: [
      { rank_from: 2, rank_to: 3, reward: 200, label: null },
      { rank_from: 1, rank_to: 1, reward: 500, label: "Champion" },
    ] }));
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value?.prize_tiers.map((t) => t.rank_from)).toEqual([1, 2]);
  });

  it("rejects a non-object", () => {
    const result = validateCompetitionConfig(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("config must be an object");
  });

  it("requires an end after the start", () => {
    const result = validateCompetitionConfig(
      makeConfig({ starts_at: "2026-10-15T00:00:00Z", ends_at: "2026-10-01T00:00:00Z" })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ends_at must be after starts_at");
  });

  it("rejects an unknown scoring method", () => {
    const result = validateCompetitionConfig({ ...makeConfig(), scoring_method: "vibes" });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("scoring_method"))).toBe(true);
  });

  it("requires at least one eligible underlying", () => {
    const result = validateCompetitionConfig(makeConfig({ eligible_underlyings: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("eligible_underlyings must list at least one underlying");
  });

  it("rejects overlapping prize tiers", () => {
    const result = validateCompetitionConfig(
      makeConfig({
        prize_tiers: [
          { rank_from: 1, rank_to: 3, reward: 500, label: null },
          { rank_from: 3, rank_to: 5, reward: 200, label: null },
        ],
      })
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("prize_tiers must not overlap");
  });

  it("rejects non-positive minimums", () => {
    const result = validateCompetitionConfig(makeConfig({ min_trades: 0, min_volume: -1 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("min_trades must be an integer >= 1");
    expect(result.errors).toContain("min_volume must be a number >= 0");
  });

  it("keeps an absent registration close distinct from an explicit null", () => {
    const absent = makeConfig();
    delete absent.registration_closes_at;
    const absentResult = validateCompetitionConfig(absent);
    expect(absentResult.ok).toBe(true);
    expect(absentResult.value?.registration_closes_at).toBeUndefined();
    // Absent means "closes at the start", not "open until the end".
    expect(registrationWindowOf(absentResult.value!, START)).toBe("closed");

    const explicitNull = validateCompetitionConfig(makeConfig({ registration_closes_at: null }));
    expect(explicitNull.value?.registration_closes_at).toBeNull();
    expect(registrationWindowOf(explicitNull.value!, START)).toBe("open");
  });

  it("accepts null optional fields and rejects a malformed registration close", () => {
    const ok = validateCompetitionConfig(makeConfig({ max_daily_trades: null, registration_closes_at: null }));
    expect(ok.ok).toBe(true);
    expect(ok.value?.max_daily_trades).toBeNull();

    const bad = validateCompetitionConfig({ ...makeConfig(), registration_closes_at: "yesterday" });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toContain("registration_closes_at must be null or an ISO-8601 instant");
  });
});

describe("scoring display", () => {
  it("labels the scoring methods", () => {
    expect(scoringMethodLabel("percent_return")).toBe("% Return");
    expect(scoringMethodLabel("pnl")).toBe("P&L");
    expect(scoringMethodLabel("risk_adjusted")).toBe("Risk-Adjusted Score");
  });

  it("formats the ranking value per method", () => {
    expect(formatScore("percent_return", 12.5)).toBe("+12.50%");
    expect(formatScore("pnl", 250)).toBe("+$250.00");
    expect(formatScore("risk_adjusted", 1.234)).toBe("1.23");
    expect(formatScore("percent_return", null)).toBe("—");
  });

  it("formats signed values", () => {
    expect(formatPercentReturn(-3.2)).toBe("−3.20%");
    expect(formatSignedUsd(-250)).toBe("−$250.00");
    expect(formatSignedUsd(null)).toBe("—");
  });
});

describe("prize tiers", () => {
  it("maps a rank to its band and returns null below the table", () => {
    const tiers = makeConfig().prize_tiers;
    expect(prizeTierForRank(tiers, 1)?.reward).toBe(500);
    expect(prizeTierForRank(tiers, 3)?.reward).toBe(200);
    expect(prizeTierForRank(tiers, 4)).toBeNull();
  });

  it("sums the advertised pool", () => {
    expect(totalPrizePool(makeConfig().prize_tiers)).toBe(700);
  });
});

describe("anti-gaming display rules", () => {
  it("states every configured threshold", () => {
    const rules = antiGamingRules(makeConfig());
    expect(rules[0]).toContain("Minimum 3 trades");
    expect(rules.join(" ")).toContain("$1,000.00");
    expect(rules.join(" ")).toContain("20 trades per day");
  });

  it("omits thresholds that are not configured", () => {
    const rules = antiGamingRules(makeConfig({ min_volume: 0, max_daily_trades: null }));
    expect(rules.join(" ")).not.toContain("notional");
    expect(rules.join(" ")).not.toContain("per day");
  });
});

describe("display names", () => {
  const address = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUV";

  it("truncates long addresses and leaves short ones alone", () => {
    expect(truncateAddress(address)).toBe("GABC…STUV");
    expect(truncateAddress("GSHORT")).toBe("GSHORT");
  });

  it("shows the opted-in name when there is one", () => {
    expect(displayNameFor({ display_name: "aurora", wallet_address: address })).toBe("aurora");
    expect(hasDisplayName({ display_name: "aurora" })).toBe(true);
  });

  it("falls back to a truncated address and treats blank names as absent", () => {
    expect(displayNameFor({ display_name: null, wallet_address: address })).toBe("GABC…STUV");
    expect(displayNameFor({ display_name: "   ", wallet_address: address })).toBe("GABC…STUV");
    expect(hasDisplayName({ display_name: "  " })).toBe(false);
  });
});

describe("leaderboard helpers", () => {
  it("marks equal scores as tied and leaves distinct ones alone", () => {
    const rows = annotateTies([
      makeEntry({ rank: 1, score: 10, wallet_address: "A" }),
      makeEntry({ rank: 2, score: 10, wallet_address: "B" }),
      makeEntry({ rank: 3, score: 9, wallet_address: "C" }),
    ]);
    expect(rows.map((r) => r.tied)).toEqual([true, true, false]);
    expect(formatRank(rows[0]!.rank, rows[0]!.tied)).toBe("=1");
    expect(formatRank(rows[2]!.rank, rows[2]!.tied)).toBe("3");
  });

  it("computes page counts", () => {
    expect(pageCount(0, 25)).toBe(1);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(60, 25)).toBe(3);
  });
});

describe("formatInstant", () => {
  it("renders a readable instant and a dash for junk", () => {
    expect(formatInstant("2026-10-01T00:00:00Z")).toMatch(/2026/);
    expect(formatInstant(null)).toBe("—");
    expect(formatInstant("not-a-date")).toBe("—");
  });
});
