import { describe, expect, it } from "vitest";
import { HkMomentumPolicyEngineEntity } from "./engine";
import { ManualNewsGrabber } from "./policy-agent";
import type { MarketDataSource } from "./market-data";
import type { AccountStateEntity, DailyBar, NewsItem, SymbolSnapshot } from "./types";

function buildBars(count: number, start: number, step: number): DailyBar[] {
  const bars: DailyBar[] = [];
  for (let i = 0; i < count; i++) {
    const close = start + step * i;
    bars.push({
      date: `2026-04-${String(i + 1).padStart(2, "0")}`,
      open: close - 0.1,
      high: close + 0.2,
      low: close - 0.3,
      close,
      volume: 1_000_000,
      turnover: 2_000_000_000,
    });
  }
  return bars;
}

function fakeMarket(symbols: string[]): MarketDataSource {
  return {
    async loadSnapshots(): Promise<SymbolSnapshot[]> {
      return symbols.map((symbol) => {
        const bars = buildBars(60, 10, 0.1);
        const last = bars[bars.length - 1]!.close;
        return {
          symbol,
          name: symbol,
          bars,
          lastPrice: last + 2,
          preClose: last,
          intradayVolume: 2_000_000,
        };
      });
    },
  };
}

const NOW = "2026-05-06T08:00:00.000Z";

const baseAccount: AccountStateEntity = {
  totalEquityHkd: 1_000_000,
  realizedPnlToday: 0,
  realizedPnlHistory: [],
  peakEquityHkd: 1_000_000,
};

describe("HkMomentumPolicyEngineEntity", () => {
  it("emits decisions only when momentum + strong catalyst align", async () => {
    const news: NewsItem[] = [
      {
        id: "n1",
        title: "央行AI算力再贷款扩围",
        source: "Test",
        publishedAt: NOW,
        summary: "支持算力租赁",
        symbols: ["00700.HK"],
        sectors: ["AI"],
      },
    ];
    const engine = new HkMomentumPolicyEngineEntity({
      marketData: fakeMarket(["00700.HK", "09988.HK"]),
      newsGrabber: new ManualNewsGrabber(() => news),
    });
    const result = await engine.run({
      universe: ["00700.HK", "09988.HK"],
      account: baseAccount,
      positions: [],
      now: NOW,
    });
    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0]!.symbol).toBe("00700.HK");
    expect(result.decisions[0]!.stopLoss).toBeLessThan(result.decisions[0]!.entryPrice);
    expect(result.decisions[0]!.positionSizeShares).toBeGreaterThan(0);
  });

  it("skips when no strong catalyst", async () => {
    const engine = new HkMomentumPolicyEngineEntity({
      marketData: fakeMarket(["00700.HK"]),
      newsGrabber: new ManualNewsGrabber(() => []),
    });
    const result = await engine.run({
      universe: ["00700.HK"],
      account: baseAccount,
      positions: [],
      now: NOW,
    });
    expect(result.decisions).toHaveLength(0);
  });

  it("respects risk gate (drawdown halt)", async () => {
    const engine = new HkMomentumPolicyEngineEntity({
      marketData: fakeMarket(["00700.HK"]),
      newsGrabber: new ManualNewsGrabber(() => []),
    });
    const result = await engine.run({
      universe: ["00700.HK"],
      account: { ...baseAccount, totalEquityHkd: 900_000 },
      positions: [],
      now: NOW,
    });
    expect(result.riskGateReason).toBeTruthy();
    expect(result.decisions).toHaveLength(0);
  });

  it("buildReport produces deterministic header", async () => {
    const engine = new HkMomentumPolicyEngineEntity({
      marketData: fakeMarket([]),
      newsGrabber: new ManualNewsGrabber(() => []),
    });
    const md = engine.buildReport({
      reportDate: "2026-05-06",
      hsiClose: 25898,
      hsiChangePct: 0.012,
      southboundNetHkd: 5_000_000_000,
      news: [],
      assessments: [],
      signals: [],
      decisions: [],
      positions: [],
      closedToday: [],
      account: baseAccount,
      weeklyPnlHkd: 0,
      monthlyPnlHkd: 0,
    });
    expect(md.startsWith("# 量价突破 + 政策催化策略执行报告")).toBe(true);
    expect(md).toContain("HSI 收 25898");
  });
});
