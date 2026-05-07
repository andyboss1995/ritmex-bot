import { describe, expect, it } from "vitest";
import { HK_MOMENTUM_SCENARIOS, runMonteCarlo } from "./expected-return";

describe("runMonteCarlo", () => {
  it("is deterministic for fixed seed", () => {
    const a = runMonteCarlo(HK_MOMENTUM_SCENARIOS[1]!, 2000, 7);
    const b = runMonteCarlo(HK_MOMENTUM_SCENARIOS[1]!, 2000, 7);
    expect(a.meanReturnPct).toBe(b.meanReturnPct);
    expect(a.probDoubleEquity).toBe(b.probDoubleEquity);
  });

  it("zero edge → near-zero expectancy and zero double prob is small", () => {
    const r = runMonteCarlo(
      {
        name: "neutral",
        winRate: 0.5,
        payoffRatio: 1,
        tradesPerWeek: 5,
        perTradeRiskPct: 0.02,
        weeks: 26,
        drawdownHaltPct: 0.99,
      },
      4000,
      1
    );
    expect(Math.abs(r.expectedTradePnlPct)).toBeLessThan(1e-9);
    expect(r.probDoubleEquity).toBeLessThan(0.05);
  });

  it("higher edge produces higher mean", () => {
    const low = runMonteCarlo(HK_MOMENTUM_SCENARIOS[0]!, 2000, 11);
    const high = runMonteCarlo(HK_MOMENTUM_SCENARIOS[2]!, 2000, 11);
    expect(high.meanReturnPct).toBeGreaterThan(low.meanReturnPct);
    expect(high.probDoubleEquity).toBeGreaterThanOrEqual(low.probDoubleEquity);
  });

  it("percentiles ordered", () => {
    const r = runMonteCarlo(HK_MOMENTUM_SCENARIOS[1]!, 3000, 3);
    expect(r.p05ReturnPct).toBeLessThanOrEqual(r.p25ReturnPct);
    expect(r.p25ReturnPct).toBeLessThanOrEqual(r.medianReturnPct);
    expect(r.medianReturnPct).toBeLessThanOrEqual(r.p75ReturnPct);
    expect(r.p75ReturnPct).toBeLessThanOrEqual(r.p95ReturnPct);
  });
});
