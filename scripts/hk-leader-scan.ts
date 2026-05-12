/**
 * 屡创新高领涨股扫描器 (基于现有 universe kline 数据).
 *
 * 输出每只股票的:
 *   - 60 日新高频次 (近 20 日内)
 *   - 相对强度排名 (60 日累计涨幅在 universe 中的百分位)
 *   - 距上次新高天数
 *   - 是否回踩 EMA10/EMA21 (pullback 入场点)
 *   - 量能放/缩
 *
 * 用法:
 *   bun run scripts/hk-leader-scan.ts                 # 用默认 hk_universe_kline.json
 *   bun run scripts/hk-leader-scan.ts --top 30        # 显示前 30
 *   bun run scripts/hk-leader-scan.ts --pullback-only # 只显示有回踩入场点的
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; turnover: number; }
interface Entry { symbol: string; name: string; bars: Bar[]; }
interface Universe { start: string; end: string; series: Entry[]; }

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0]!;
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function atr(bars: Bar[], period: number): number {
  const n = Math.min(period, bars.length - 1);
  if (n < 2) return NaN;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = bars[i]!, p = bars[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / n;
}

interface LeaderRow {
  symbol: string;
  name: string;
  lastClose: number;
  ret60d: number;
  rsRank: number;
  newHighsLast20: number;
  daysSinceLastHigh: number;
  ema10: number;
  ema21: number;
  pullbackZone: "below_ema21" | "near_ema21" | "near_ema10" | "extended";
  volRatio20: number;
  avgTurnover20Hkd: number;
  atr14: number;
}

function analyze(entry: Entry): LeaderRow | null {
  const bars = entry.bars;
  if (bars.length < 80) return null;

  const closes = bars.map((b) => b.close);
  const lastClose = closes[closes.length - 1]!;
  const close60Ago = closes[closes.length - 61]!;
  const ret60d = (lastClose - close60Ago) / close60Ago;

  const ema10s = ema(closes, 10);
  const ema21s = ema(closes, 21);
  const ema10 = ema10s[ema10s.length - 1]!;
  const ema21 = ema21s[ema21s.length - 1]!;

  // 60 日新高: 第 i 天的 high 大于过去 60 日的 high
  let newHighsLast20 = 0;
  let daysSinceLastHigh = 9999;
  for (let i = bars.length - 20; i < bars.length; i++) {
    const window = bars.slice(Math.max(0, i - 60), i);
    if (window.length < 30) continue;
    const prevHigh = Math.max(...window.map((b) => b.high));
    if (bars[i]!.high > prevHigh) {
      newHighsLast20++;
      daysSinceLastHigh = bars.length - 1 - i;
    }
  }

  // 量能 (近 5 日平均 / 近 20 日平均)
  const vol5 = bars.slice(-5).reduce((a, b) => a + b.volume, 0) / 5;
  const vol20 = bars.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
  const volRatio20 = vol20 > 0 ? vol5 / vol20 : 0;
  const avgTurnover20Hkd = bars.slice(-20).reduce((a, b) => a + b.turnover, 0) / 20;

  const atr14 = atr(bars, 14);

  let pullbackZone: LeaderRow["pullbackZone"];
  if (lastClose < ema21) pullbackZone = "below_ema21";
  else if (Math.abs(lastClose - ema21) <= atr14 * 0.5) pullbackZone = "near_ema21";
  else if (Math.abs(lastClose - ema10) <= atr14 * 0.5) pullbackZone = "near_ema10";
  else pullbackZone = "extended";

  return {
    symbol: entry.symbol,
    name: entry.name,
    lastClose,
    ret60d,
    rsRank: 0, // 计算时填充
    newHighsLast20,
    daysSinceLastHigh,
    ema10,
    ema21,
    pullbackZone,
    volRatio20,
    avgTurnover20Hkd,
    atr14,
  };
}

function main(): void {
  const path = resolve(process.cwd(), "data/hk_universe_kline.json");
  const u: Universe = JSON.parse(readFileSync(path, "utf-8"));
  const top = Number(process.argv.includes("--top") ? process.argv[process.argv.indexOf("--top") + 1] : 50);
  const pullbackOnly = process.argv.includes("--pullback-only");
  const minTurnover = Number(process.env.MIN_TURNOVER_HKD ?? 300_000_000);
  const minNewHighs = Number(process.env.MIN_NEW_HIGHS ?? 2);

  const rows: LeaderRow[] = [];
  for (const e of u.series) {
    const r = analyze(e);
    if (!r) continue;
    if (r.avgTurnover20Hkd < minTurnover) continue;
    if (r.newHighsLast20 < minNewHighs) continue;
    rows.push(r);
  }

  rows.sort((a, b) => b.ret60d - a.ret60d);
  rows.forEach((r, i) => (r.rsRank = (i + 1) / rows.length));

  let display = rows;
  if (pullbackOnly) display = rows.filter((r) => r.pullbackZone === "near_ema10" || r.pullbackZone === "near_ema21");

  console.log(`==== HK Leader Scan ${u.end} ====`);
  console.log(`Universe: ${u.series.length}, qualified: ${rows.length}, displayed: ${Math.min(top, display.length)}`);
  console.log(`Filters: turnover>=${(minTurnover / 1e6).toFixed(0)}M, newHighsLast20>=${minNewHighs}${pullbackOnly ? ", pullback-only" : ""}`);
  console.log("");
  console.log(
    "Symbol     Name                 Close    60dRet   RSRank  Highs  DaysAgo  Vol5/20  Zone           ATR    Turnover20"
  );
  console.log("-".repeat(120));
  for (const r of display.slice(0, top)) {
    const name = (r.name || "").slice(0, 18).padEnd(18);
    console.log(
      `${r.symbol.padEnd(10)} ${name}  ${r.lastClose.toFixed(2).padStart(7)}  ${(r.ret60d * 100).toFixed(1).padStart(6)}%  ${(r.rsRank * 100).toFixed(0).padStart(5)}%  ${String(r.newHighsLast20).padStart(4)}  ${String(r.daysSinceLastHigh).padStart(7)}  ${r.volRatio20.toFixed(2).padStart(6)}  ${r.pullbackZone.padEnd(13)}  ${r.atr14.toFixed(2).padStart(5)}  ${(r.avgTurnover20Hkd / 1e8).toFixed(1)}亿`
    );
  }

  // 给出今日"可入场"清单 (高质量 + 回踩位)
  const entryCandidates = rows.filter(
    (r) => r.rsRank >= 0.85 && r.pullbackZone === "near_ema10" && r.daysSinceLastHigh <= 8
  );
  if (entryCandidates.length > 0) {
    console.log("\n==== 今日候选入场清单 (RS>85%, 回踩EMA10, 最近8日内创过新高) ====");
    for (const r of entryCandidates) {
      const stop = r.lastClose - r.atr14 * 2.5;
      const riskPerShare = r.lastClose - stop;
      const target = r.lastClose + r.atr14 * 5;
      console.log(
        `  ${r.symbol} ${r.name} @ ${r.lastClose.toFixed(2)}  止损 ${stop.toFixed(2)} (-${(((r.lastClose - stop) / r.lastClose) * 100).toFixed(1)}%)  目标 ${target.toFixed(2)} (+${(((target - r.lastClose) / r.lastClose) * 100).toFixed(1)}%)  R/risk=${(((target - r.lastClose) / riskPerShare)).toFixed(1)}`
      );
    }
  } else {
    console.log("\n今日无符合条件的回踩入场标的 (可能市场过热, 等回踩或换股池).");
  }
}

main();
