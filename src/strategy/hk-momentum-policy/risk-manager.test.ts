import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config";
import { RiskManagerEntity } from "./risk-manager";
import type { AccountStateEntity, PositionEntity } from "./types";

function makeAccount(over: Partial<AccountStateEntity> = {}): AccountStateEntity {
  return {
    totalEquityHkd: 1_000_000,
    realizedPnlToday: 0,
    realizedPnlHistory: [],
    peakEquityHkd: 1_000_000,
    ...over,
  };
}

const NOW = "2026-05-06T08:00:00.000Z";

describe("RiskManagerEntity", () => {
  it("allows opening with full daily budget by default", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    const gate = rm.evaluate(makeAccount(), [], NOW);
    expect(gate.canOpen).toBe(true);
    expect(gate.remainingRiskBudgetHkd).toBeCloseTo(1_000_000 * defaultConfig.dailyRiskCapPct);
  });

  it("blocks when max positions reached", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    const positions: PositionEntity[] = Array.from({ length: defaultConfig.maxPositions }, (_, i) => ({
      symbol: `S${i}`,
      name: `S${i}`,
      side: "long",
      entryPrice: 10,
      stopLoss: 9.8,
      takeProfit: 10.5,
      shares: 100,
      openedAt: NOW,
      partialTaken: false,
      trailingHigh: 10,
    }));
    const gate = rm.evaluate(makeAccount(), positions, NOW);
    expect(gate.canOpen).toBe(false);
  });

  it("blocks when drawdown > 8%", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    const gate = rm.evaluate(
      makeAccount({ totalEquityHkd: 900_000, peakEquityHkd: 1_000_000 }),
      [],
      NOW
    );
    expect(gate.canOpen).toBe(false);
    expect(gate.reason).toContain("回撤");
  });

  it("blocks when daily risk exhausted by realized losses", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    const gate = rm.evaluate(
      makeAccount({ realizedPnlToday: -60_000 }),
      [],
      NOW
    );
    expect(gate.canOpen).toBe(false);
  });

  it("registerDailyClose pauses after consecutive losses", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    let acc = makeAccount({ realizedPnlToday: -1000, realizedPnlHistory: [-500] });
    acc = rm.registerDailyClose(acc, NOW);
    expect(acc.pausedUntil).toBeTruthy();
    expect(acc.realizedPnlToday).toBe(0);
  });

  it("registerDailyClose halts on drawdown", () => {
    const rm = new RiskManagerEntity(defaultConfig);
    let acc = makeAccount({ totalEquityHkd: 900_000, peakEquityHkd: 1_000_000, realizedPnlToday: 0 });
    acc = rm.registerDailyClose(acc, NOW);
    expect(acc.haltedUntil).toBeTruthy();
  });
});
