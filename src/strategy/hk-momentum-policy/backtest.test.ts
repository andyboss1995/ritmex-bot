import { describe, expect, it } from "vitest";
import { BacktestEngineEntity, type HistoricalSeries } from "./backtest";
import type { DailyBar, NewsItem } from "./types";

function buildSeries(symbol: string, count: number, start: number, drift: number, surgeIdx: number): HistoricalSeries {
  const bars: DailyBar[] = [];
  const epoch = Date.UTC(2026, 0, 1);
  for (let i = 0; i < count; i++) {
    const close = start + drift * i + (i === surgeIdx ? 1.5 : 0);
    const volume = i === surgeIdx ? 5_000_000 : 1_000_000;
    const d = new Date(epoch + i * 86400000).toISOString().slice(0, 10);
    bars.push({
      date: d,
      open: close - 0.05,
      high: close + 0.3,
      low: close - 0.4,
      close,
      volume,
      turnover: 2_000_000_000,
    });
  }
  return { symbol, name: symbol, bars };
}

describe("BacktestEngineEntity", () => {
  it("records trades and final equity for a winning surge with strong catalyst", async () => {
    const series = [buildSeries("00700.HK", 70, 100, 0.05, 50)];
    const surgeDate = series[0]!.bars[50]!.date;
    const newsByDate: Record<string, NewsItem[]> = {
      [surgeDate]: [
        {
          id: "n1",
          title: "央行AI算力再贷款扩围, 利好00700.HK",
          source: "test",
          publishedAt: surgeDate,
          summary: "AI算力再贷款",
          symbols: ["00700.HK"],
          sectors: ["AI"],
          keywords: ["AI", "算力", "再贷款"],
        },
      ],
    };
    const engine = new BacktestEngineEntity({
      series,
      newsByDate,
      initialEquityHkd: 1_000_000,
    });
    const result = await engine.run({
      series,
      newsByDate,
      initialEquityHkd: 1_000_000,
    });
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.trades.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(result.totalReturnPct)).toBe(true);
    expect(Number.isFinite(result.maxDrawdownPct)).toBe(true);
  });

  it("no catalyst → no trades", async () => {
    const series = [buildSeries("00700.HK", 70, 100, 0.05, 50)];
    const engine = new BacktestEngineEntity({
      series,
      newsByDate: {},
      initialEquityHkd: 1_000_000,
    });
    const result = await engine.run({
      series,
      newsByDate: {},
      initialEquityHkd: 1_000_000,
    });
    expect(result.trades).toHaveLength(0);
    expect(result.totalReturnPct).toBe(0);
  });
});
