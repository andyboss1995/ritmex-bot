import type { HkMomentumPolicyConfig } from "./config";
import { averageVolume, highest, macd, rsi, sma } from "./indicators";
import type { MomentumSignal, SymbolSnapshot } from "./types";

export function evaluateMomentum(
  snapshot: SymbolSnapshot,
  config: HkMomentumPolicyConfig,
  now: string = new Date().toISOString()
): MomentumSignal | null {
  const { bars, lastPrice, intradayVolume, symbol, name } = snapshot;
  if (bars.length < Math.max(config.breakoutSmaWindow, config.macdSlow + config.macdSignal)) {
    return null;
  }

  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);

  const closesIncludingToday = [...closes, lastPrice];
  const sma20 = sma(closes, config.breakoutSmaWindow);
  const high20 = highest(
    bars.slice(0, bars.length).map((b) => b.high),
    config.breakoutHighWindow
  );
  const avgVol = averageVolume(volumes, config.volumeLookback);
  if (!Number.isFinite(sma20) || !Number.isFinite(high20) || !Number.isFinite(avgVol) || avgVol <= 0) {
    return null;
  }

  const volumeRatio = intradayVolume / avgVol;
  const breakoutSma = lastPrice > sma20;
  const breakoutHigh = lastPrice > high20;
  if (!breakoutSma && !breakoutHigh) return null;
  if (volumeRatio < config.volumeMultiplier) return null;

  const rsiValue = rsi(closesIncludingToday, config.rsiPeriod);
  if (!Number.isFinite(rsiValue) || rsiValue <= config.rsiThreshold) return null;

  const macdResult = macd(closesIncludingToday, config.macdFast, config.macdSlow, config.macdSignal);
  if (!Number.isFinite(macdResult.histogram) || macdResult.histogram <= 0) return null;

  const breakoutType: MomentumSignal["breakoutType"] =
    breakoutSma && breakoutHigh ? "both" : breakoutSma ? "sma" : "high";

  const atr = computeAtr(bars, config.atrPeriod);

  return {
    symbol,
    name,
    triggeredAt: now,
    lastPrice,
    volumeRatio,
    sma20,
    high20,
    rsi: rsiValue,
    macdHist: macdResult.histogram,
    breakoutType,
    atr: Number.isFinite(atr) ? atr : undefined,
  };
}

function computeAtr(bars: Array<{ high: number; low: number; close: number }>, period: number): number {
  const n = Math.min(period, bars.length - 1);
  if (n < 2) return NaN;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return sum / n;
}

export function scanUniverse(
  snapshots: SymbolSnapshot[],
  config: HkMomentumPolicyConfig,
  now?: string
): MomentumSignal[] {
  const out: MomentumSignal[] = [];
  for (const snap of snapshots) {
    const lastBar = snap.bars[snap.bars.length - 1];
    if (lastBar && lastBar.turnover < config.minDailyTurnoverHkd) continue;
    const signal = evaluateMomentum(snap, config, now);
    if (signal) out.push(signal);
  }
  out.sort((a, b) => b.volumeRatio - a.volumeRatio);
  return out;
}
