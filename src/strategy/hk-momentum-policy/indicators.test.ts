import { describe, expect, it } from "vitest";
import { averageVolume, ema, highest, macd, rsi, sma } from "./indicators";

describe("indicators", () => {
  it("sma computes mean of last N", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toBe(4);
    expect(sma([1, 2], 5)).toBeNaN();
  });

  it("ema first value equals first input", () => {
    const series = ema([1, 2, 3, 4, 5], 3);
    expect(series).toHaveLength(5);
    expect(series[0]).toBe(1);
    expect(series[4]).toBeGreaterThan(3);
  });

  it("rsi returns 100 when only gains", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });

  it("rsi returns near 50 for noisy series with no drift", () => {
    const closes = [10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11];
    const v = rsi(closes, 14);
    expect(v).toBeGreaterThan(40);
    expect(v).toBeLessThan(60);
  });

  it("macd histogram positive for uptrend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i * 0.5);
    const r = macd(closes, 12, 26, 9);
    expect(r.histogram).toBeGreaterThan(0);
  });

  it("highest returns max of last N", () => {
    expect(highest([1, 5, 3, 4, 2], 3)).toBe(4);
  });

  it("averageVolume == sma", () => {
    expect(averageVolume([10, 20, 30, 40, 50], 5)).toBe(30);
  });
});
