import { describe, expect, it } from "vitest";

import { costMicroUsd, DAILY_CAP_MESSAGE, decideStart, formatCredits, milliCreditsFor, shareByPages, toMilliCredits } from "./rate";

// Phase 22: this arithmetic decides what a reading charges and whether one may start. A silent bug
// here either gives readings away on the owner's bill or takes credits a user didn't spend.

describe("what a reading costs", () => {
  it("prices tokens at the model's list price, in whole millionths of a dollar", () => {
    // 3.5 Flash: $1.50 in, $9.00 out per million tokens.
    expect(costMicroUsd({ model: "gemini-3.5-flash", inputTokens: 3000, outputTokens: 1200 })).toBe(4500 + 10_800);
    // The reading these prices were checked against: Google billed it $0.0285.
    expect(costMicroUsd({ model: "gemini-3.5-flash", inputTokens: 1766, outputTokens: 2870 })).toBe(28_479);
    // 3.7 Flash is priced apart: $0.75 in, $3.75 out.
    expect(costMicroUsd({ model: "gemini-3.7-flash", inputTokens: 1766, outputTokens: 2870, at: new Date("2026-10-06T00:00:00Z") })).toBe(12_087);
    expect(costMicroUsd({ model: "gemini-3.5-flash", inputTokens: 1, outputTokens: 0 })).toBe(2);
    expect(costMicroUsd({ model: "gemini-3.5-flash", inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("costs nothing on a model it has no price for, rather than guessing", () => {
    expect(costMicroUsd({ model: "retired-model", inputTokens: 5000, outputTokens: 5000 })).toBe(0);
  });

  it("turns $0.02 into one credit and rounds a charge up", () => {
    expect(toMilliCredits(20_000)).toBe(1000);
    expect(toMilliCredits(15_300)).toBe(765);
    expect(toMilliCredits(1)).toBe(1);
    expect(toMilliCredits(0)).toBe(0);
    expect(milliCreditsFor({ model: "gemini-3.5-flash", inputTokens: 3000, outputTokens: 1200 })).toBe(765);
  });

  it("charges a full table page several times a short form page", () => {
    const form = milliCreditsFor({ model: "gemini-3.5-flash", inputTokens: 3000, outputTokens: 600 });
    const table = milliCreditsFor({ model: "gemini-3.5-flash", inputTokens: 3500, outputTokens: 6000 });
    expect(table).toBeGreaterThan(form * 4);
  });

  it("applies an announced price change from its day, and not before", () => {
    const reading = { model: "gemini-3.7-flash", inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(costMicroUsd({ ...reading, at: new Date("2026-12-31T23:59:59Z") })).toBe(750_000 + 3_750_000);
    expect(costMicroUsd({ ...reading, at: new Date("2027-01-01T00:00:00Z") })).toBe(1_500_000 + 7_500_000);
    // A model with no change announced costs the same on both days.
    const steady = { model: "gemini-3.5-flash", inputTokens: 1_000_000, outputTokens: 0 };
    expect(costMicroUsd({ ...steady, at: new Date("2027-06-01T00:00:00Z") })).toBe(1_500_000);
  });

  it("rounds what is needed up and what is there down, so a refusal never shows two equal numbers", () => {
    expect(formatCredits(975, "up")).toBe("1.0");
    expect(formatCredits(960, "down")).toBe("0.9");
    expect(decideStart({ estimate: 975, available: 960, dailyUsed: 0, dailyCap: null })).toMatchObject({
      message: "This needs about 1.0 credit. You have 0.9.",
    });
  });

  it("shows one decimal", () => {
    expect(formatCredits(25_000)).toBe("25.0");
    expect(formatCredits(975)).toBe("1.0");
    expect(formatCredits(82)).toBe("0.1");
    expect(formatCredits(1_234_560)).toBe("1,234.6");
  });
});

describe("holding an estimate over a document's runs", () => {
  it("shares it by pages and never holds less than the estimate", () => {
    expect(shareByPages(1000, [4, 4, 2])).toEqual([400, 400, 200]);
    const shares = shareByPages(1000, [1, 1, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1000);
    expect(shareByPages(1000, [])).toEqual([]);
  });
});

describe("whether a reading may start", () => {
  const open = { dailyUsed: 0, dailyCap: null };

  it("starts when the estimate fits, exactly or with room", () => {
    expect(decideStart({ estimate: 4000, available: 4000, ...open })).toEqual({ ok: true });
    expect(decideStart({ estimate: 4000, available: 25_000, ...open })).toEqual({ ok: true });
  });

  it("refuses when it doesn't fit, and says both numbers", () => {
    const decision = decideStart({ estimate: 40_000, available: 12_000, ...open });
    expect(decision).toEqual({ ok: false, reason: "short", message: "This needs about 40.0 credits. You have 12.0." });
  });

  it("refuses the next start once a reading has taken the balance below zero", () => {
    const decision = decideStart({ estimate: 100, available: -300, ...open });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.message).toBe("This needs about 0.1 credits. You have 0.0.");
  });

  it("never refuses for want of credits where they aren't enforced", () => {
    expect(decideStart({ estimate: 1_000_000, available: null, ...open })).toEqual({ ok: true });
  });

  it("refuses everyone at the daily ceiling, even with credits to spare", () => {
    expect(decideStart({ estimate: 1000, available: 50_000, dailyUsed: 99_500, dailyCap: 100_000 })).toEqual({
      ok: false,
      reason: "daily",
      message: DAILY_CAP_MESSAGE,
    });
    expect(decideStart({ estimate: 500, available: 50_000, dailyUsed: 99_500, dailyCap: 100_000 })).toEqual({ ok: true });
    expect(decideStart({ estimate: 1000, available: null, dailyUsed: 99_500, dailyCap: 100_000 }).ok).toBe(false);
  });

  it("tells a user who is short that, not that the day is full", () => {
    const decision = decideStart({ estimate: 5000, available: 1000, dailyUsed: 100_000, dailyCap: 100_000 });
    expect(decision.ok === false && decision.reason).toBe("short");
  });
});
