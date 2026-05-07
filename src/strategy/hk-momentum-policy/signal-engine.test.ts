import { describe, expect, it } from "vitest";
import { defaultConfig } from "./config";
import { evaluateMomentum } from "./signal-engine";
import type { DailyBar, SymbolSnapshot } from "./types";

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

describe("evaluateMomentum", () => {
  it("returns null when volume not surging", () => {
    const bars = buildBars(60, 10, 0.1);
    const snap: SymbolSnapshot = {
      symbol: "00700.HK",
      name: "Test",
      bars,
      lastPrice: bars[bars.length - 1]!.close + 1,
      preClose: bars[bars.length - 1]!.close,
      intradayVolume: 1_000_000,
    };
    const out = evaluateMomentum(snap, defaultConfig);
    expect(out).toBeNull();
  });

  it("triggers when price breaks SMA20 and volume > 1.5x avg, RSI>50, MACD hist > 0", () => {
    const bars = buildBars(60, 10, 0.1);
    const last = bars[bars.length - 1]!.close;
    const snap: SymbolSnapshot = {
      symbol: "00700.HK",
      name: "Test",
      bars,
      lastPrice: last + 2,
      preClose: last,
      intradayVolume: 2_000_000,
    };
    const out = evaluateMomentum(snap, defaultConfig);
    expect(out).not.toBeNull();
    expect(out!.volumeRatio).toBeGreaterThanOrEqual(defaultConfig.volumeMultiplier);
    expect(out!.rsi).toBeGreaterThan(50);
    expect(out!.macdHist).toBeGreaterThan(0);
  });

  it("returns null when bars are insufficient", () => {
    const snap: SymbolSnapshot = {
      symbol: "00700.HK",
      name: "Test",
      bars: buildBars(10, 10, 0.1),
      lastPrice: 12,
      preClose: 11.9,
      intradayVolume: 5_000_000,
    };
    expect(evaluateMomentum(snap, defaultConfig)).toBeNull();
  });
});
