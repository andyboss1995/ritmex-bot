import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  averageVolume,
  defaultConfig,
  type DailyBar,
  highest,
  type HistoricalSeries,
  macd,
  rsi,
  sma,
} from "../src/strategy/hk-momentum-policy";

interface KlineFile {
  start: string;
  end: string;
  series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>;
}

function loadSeries(path: string): HistoricalSeries[] {
  const raw: KlineFile = JSON.parse(readFileSync(path, "utf8"));
  return raw.series.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    bars: s.bars.map((b) => ({
      date: String(b.date),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume),
      turnover: Number(b.turnover),
    })),
  }));
}

function audit(series: HistoricalSeries[]): void {
  const cfg = defaultConfig;
  const warmup = Math.max(cfg.breakoutSmaWindow, cfg.macdSlow + cfg.macdSignal);
  let stockDays = 0;
  let liquidityPass = 0;
  let breakoutSmaOnly = 0;
  let breakoutHighOnly = 0;
  let breakoutEither = 0;
  let breakoutAndVol15 = 0;
  let breakoutAndVol18 = 0;
  let breakoutVolRsi = 0;
  let breakoutVolRsiMacd = 0;
  let allOf = 0;

  for (const s of series) {
    for (let i = warmup; i < s.bars.length; i++) {
      stockDays++;
      const bars = s.bars.slice(0, i);
      const today = s.bars[i]!;
      const closes = bars.map((b) => b.close);
      const volumes = bars.map((b) => b.volume);
      const sma20 = sma(closes, cfg.breakoutSmaWindow);
      const high20 = highest(bars.map((b) => b.high), cfg.breakoutHighWindow);
      const avgVol = averageVolume(volumes, cfg.volumeLookback);
      if (today.turnover < 50_000_000) continue;
      liquidityPass++;
      const breakSma = today.close > sma20;
      const breakHigh = today.close > high20;
      if (breakSma) breakoutSmaOnly++;
      if (breakHigh) breakoutHighOnly++;
      if (!breakSma && !breakHigh) continue;
      breakoutEither++;
      const volRatio = avgVol > 0 ? today.volume / avgVol : 0;
      if (volRatio >= 1.5) breakoutAndVol15++;
      if (volRatio < 1.5) continue;
      if (volRatio >= 1.8) breakoutAndVol18++;
      const cIncl = [...closes, today.close];
      const r = rsi(cIncl, cfg.rsiPeriod);
      if (!(r > 50)) continue;
      breakoutVolRsi++;
      const m = macd(cIncl, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
      if (!(m.histogram > 0)) continue;
      breakoutVolRsiMacd++;
      allOf++;
    }
  }

  const pct = (x: number, base: number) => `${((x / base) * 100).toFixed(2)}%`;
  console.log(`Universe scan: ${series.length} stocks × avg bars`);
  console.log(`stock-days total                  : ${stockDays}`);
  console.log(`  + 流动性 (turnover>50M)         : ${liquidityPass}  (${pct(liquidityPass, stockDays)})`);
  console.log(`  + 突破 SMA20 (单独)              : ${breakoutSmaOnly}  (${pct(breakoutSmaOnly, liquidityPass)})`);
  console.log(`  + 突破 20日高 (单独)             : ${breakoutHighOnly}  (${pct(breakoutHighOnly, liquidityPass)})`);
  console.log(`  + 突破 (SMA OR 20日高)           : ${breakoutEither}  (${pct(breakoutEither, liquidityPass)})`);
  console.log(`  + 量比≥1.5                       : ${breakoutAndVol15}  (${pct(breakoutAndVol15, breakoutEither)} of breakout)`);
  console.log(`  + 量比≥1.8                       : ${breakoutAndVol18}`);
  console.log(`  + 量价 + RSI>50                  : ${breakoutVolRsi}  (${pct(breakoutVolRsi, breakoutAndVol15)} of vol-pass)`);
  console.log(`  + 量价 + RSI + MACD柱>0          : ${breakoutVolRsiMacd}  (${pct(breakoutVolRsiMacd, breakoutVolRsi)} of rsi-pass)`);
  console.log(`  最终满足完整信号                  : ${allOf}`);
}

const path = resolve(process.cwd(), process.argv[2] ?? "data/hk_universe_kline.json");
audit(loadSeries(path));
