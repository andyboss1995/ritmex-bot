/**
 * Leader-Rider 参数扫描器: 找出在 18 个月数据上 maxDD < 15% 且 Sharpe 最高的组合
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; turnover: number; }
interface Entry { symbol: string; name: string; bars: Bar[]; }
interface Universe { start: string; end: string; series: Entry[]; }

// 简化版: 直接 import 引擎逻辑而非外部 spawn (太慢)
// 这里 inline 一份 backtest 函数, 仅返回核心指标

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1); const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}
function atrAt(bars: Bar[], idx: number, period: number): number {
  const start = Math.max(1, idx - period + 1); let sum = 0, n = 0;
  for (let i = start; i <= idx; i++) {
    const c = bars[i]!, p = bars[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

interface Cfg {
  equity: number; maxPositions: number; perTradeRiskPct: number;
  minTurnoverHkd: number; minNewHighsLast20: number; rsRankTopPct: number;
  maxDaysSinceHigh: number; atrStopMult: number; chandelierMult: number;
  feeBps: number; warmupDays: number;
  entryMode: "pullback" | "breakout";
  exitOnEma21Break: boolean;
  trailingMode: "chandelier" | "ema21" | "ema34" | "donchian10";
  pyramidLayers: number;
}

interface Pre {
  ema10: number[]; ema21: number[]; ema34: number[];
  ret60: number[]; high60: number[]; donchianLow10: number[];
  newHighsLast20: number[]; daysSinceHigh: number[]; avgTurnover20: number[];
}

function precompute(e: Entry): Pre {
  const bars = e.bars; const closes = bars.map((b) => b.close);
  const lows = bars.map((b) => b.low); const highs = bars.map((b) => b.high);
  const turnovers = bars.map((b) => b.turnover);
  const ema10 = emaSeries(closes, 10); const ema21 = emaSeries(closes, 21);
  const ema34 = emaSeries(closes, 34);
  const ret60: number[] = []; const high60: number[] = []; const donchianLow10: number[] = [];
  const newHighsLast20: number[] = []; const daysSinceHigh: number[] = []; const avgTurnover20: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const w60 = highs.slice(Math.max(0, i - 60), i);
    high60.push(w60.length ? Math.max(...w60) : -Infinity);
    const wL = lows.slice(Math.max(0, i - 10), i);
    donchianLow10.push(wL.length ? Math.min(...wL) : Infinity);
    const ago = i - 60;
    ret60.push(ago >= 0 ? (closes[i]! - closes[ago]!) / closes[ago]! : NaN);
    const tw = turnovers.slice(Math.max(0, i - 19), i + 1);
    avgTurnover20.push(tw.reduce((a, b) => a + b, 0) / tw.length);
  }
  for (let i = 0; i < bars.length; i++) {
    let cnt = 0, last = -1;
    for (let j = Math.max(0, i - 19); j <= i; j++) {
      if (j < 60) continue;
      if (bars[j]!.high > high60[j]!) { cnt++; last = j; }
    }
    newHighsLast20.push(cnt);
    daysSinceHigh.push(last >= 0 ? i - last : 9999);
  }
  return { ema10, ema21, ema34, ret60, high60, donchianLow10, newHighsLast20, daysSinceHigh, avgTurnover20 };
}

interface BtRes { totalReturn: number; cagr: number; sharpe: number; maxDD: number; winRate: number; payoff: number; trades: number; exposure: number; }

function bt(u: Universe, cfg: Cfg): BtRes {
  const entries = u.series.filter((e) => e.bars.length >= cfg.warmupDays);
  const allDates = entries[0]!.bars.map((b) => b.date);
  const pre = new Map<string, Pre>(); const idxMap = new Map<string, Map<string, number>>();
  for (const e of entries) {
    pre.set(e.symbol, precompute(e));
    const m = new Map<string, number>(); e.bars.forEach((b, i) => m.set(b.date, i));
    idxMap.set(e.symbol, m);
  }
  let cash = cfg.equity, peak = cfg.equity, maxDD = 0, exposed = 0;
  const positions = new Map<string, { shares: number; entry: number; date: string; stop: number; high: number; atr: number; layers: number }>();
  const trades: Array<{ pnl: number }> = [];
  const eq: number[] = [];

  for (let d = cfg.warmupDays; d < allDates.length - 1; d++) {
    const today = allDates[d]!; const tomorrow = allDates[d + 1]!;
    // 退出
    const toExit: Array<{ sym: string; price: number }> = [];
    for (const [sym, p] of positions) {
      const e = entries.find((x) => x.symbol === sym)!;
      const i = idxMap.get(sym)!.get(today); if (i == null) continue;
      const t = e.bars[i]!; const tom = e.bars[idxMap.get(sym)!.get(tomorrow)!];
      if (t.close > p.high) p.high = t.close;
      const pr = pre.get(sym)!;
      // 硬止损
      if (t.low <= p.stop) { toExit.push({ sym, price: p.stop }); continue; }
      // 单日跌幅
      const yC = e.bars[i - 1]?.close ?? t.close;
      if ((yC - t.close) / yC > 0.08) { toExit.push({ sym, price: tom?.open ?? t.close }); continue; }
      // EMA21 break
      if (cfg.exitOnEma21Break && t.close < pr.ema21[i]!) { toExit.push({ sym, price: tom?.open ?? t.close }); continue; }
      // Trailing
      let trail = -Infinity;
      if (cfg.trailingMode === "chandelier") trail = p.high - p.atr * cfg.chandelierMult;
      else if (cfg.trailingMode === "ema21") trail = pr.ema21[i]!;
      else if (cfg.trailingMode === "ema34") trail = pr.ema34[i]!;
      else if (cfg.trailingMode === "donchian10") trail = pr.donchianLow10[i]!;
      if (t.close < trail) toExit.push({ sym, price: tom?.open ?? t.close });
    }
    for (const ex of toExit) {
      const p = positions.get(ex.sym)!;
      const fee = (ex.price + p.entry) * p.shares * (cfg.feeBps / 10000);
      const pnl = (ex.price - p.entry) * p.shares - fee;
      cash += ex.price * p.shares - fee / 2;
      trades.push({ pnl });
      positions.delete(ex.sym);
    }
    // 入场
    if (positions.size < cfg.maxPositions) {
      const cands: Array<{ sym: string; ret: number; entry: number; atr: number }> = [];
      for (const e of entries) {
        if (positions.has(e.symbol)) continue;
        const i = idxMap.get(e.symbol)!.get(today); if (i == null) continue;
        const p = pre.get(e.symbol)!; const tb = e.bars[i]!;
        if (p.avgTurnover20[i]! < cfg.minTurnoverHkd) continue;
        if (p.newHighsLast20[i]! < cfg.minNewHighsLast20) continue;
        if (p.daysSinceHigh[i]! > cfg.maxDaysSinceHigh) continue;
        if (tb.close < p.ema21[i]!) continue;
        if (cfg.entryMode === "pullback") {
          if (!(tb.low <= p.ema10[i]! && p.ema10[i]! <= tb.close)) continue;
        } else { // breakout
          if (tb.high <= p.high60[i]!) continue;
          if (tb.close < p.high60[i]!) continue;
        }
        if (!Number.isFinite(p.ret60[i])) continue;
        cands.push({ sym: e.symbol, ret: p.ret60[i]!, entry: e.bars[i + 1]?.open ?? tb.close, atr: atrAt(e.bars, i, 14) });
      }
      if (cands.length > 0) {
        const allR: number[] = [];
        for (const e of entries) {
          const i = idxMap.get(e.symbol)!.get(today); if (i == null) continue;
          const r = pre.get(e.symbol)!.ret60[i]; if (Number.isFinite(r)) allR.push(r!);
        }
        allR.sort((a, b) => b - a);
        const cutoff = allR[Math.floor(allR.length * cfg.rsRankTopPct)] ?? -Infinity;
        cands.filter((c) => c.ret >= cutoff).sort((a, b) => b.ret - a.ret);
        for (const c of cands.filter((c) => c.ret >= cutoff)) {
          if (positions.size >= cfg.maxPositions) break;
          if (!Number.isFinite(c.atr) || c.atr <= 0) continue;
          const stop = c.entry - c.atr * cfg.atrStopMult;
          const risk = c.entry - stop; if (risk <= 0) continue;
          const totalEq = cash + [...positions.entries()].reduce((a, [s, p]) => {
            const ee = entries.find((x) => x.symbol === s)!;
            const ii = idxMap.get(s)!.get(today)!;
            return a + ee.bars[ii]!.close * p.shares;
          }, 0);
          const budget = totalEq * cfg.perTradeRiskPct;
          const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
          if (shares <= 0) continue;
          const cost = shares * c.entry;
          if (cost > cash) continue;
          const fee = cost * (cfg.feeBps / 10000);
          cash -= cost + fee / 2;
          positions.set(c.sym, { shares, entry: c.entry, date: tomorrow, stop, high: c.entry, atr: c.atr, layers: 1 });
        }
      }
    }
    let mtm = 0;
    for (const [s, p] of positions) {
      const ee = entries.find((x) => x.symbol === s)!;
      const ii = idxMap.get(s)!.get(today); if (ii == null) continue;
      mtm += ee.bars[ii]!.close * p.shares;
    }
    const totalEq = cash + mtm;
    eq.push(totalEq);
    if (positions.size > 0) exposed++;
    if (totalEq > peak) peak = totalEq;
    const dd = (peak - totalEq) / peak; if (dd > maxDD) maxDD = dd;
  }
  // 强平
  for (const [sym, p] of positions) {
    const e = entries.find((x) => x.symbol === sym)!;
    const last = e.bars[e.bars.length - 1]!;
    const fee = (last.close + p.entry) * p.shares * (cfg.feeBps / 10000);
    trades.push({ pnl: (last.close - p.entry) * p.shares - fee });
    cash += last.close * p.shares - fee / 2;
  }
  const finalEq = cash;
  const totalRet = (finalEq - cfg.equity) / cfg.equity;
  const years = allDates.length / 252;
  const cagr = years > 0 ? Math.pow(finalEq / cfg.equity, 1 / years) - 1 : 0;
  const wins = trades.filter((t) => t.pnl > 0); const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const payoff = losses.length ? Math.abs((wins.reduce((a, b) => a + b.pnl, 0) / Math.max(1, wins.length)) / (losses.reduce((a, b) => a + b.pnl, 0) / losses.length)) : NaN;
  const dailyR: number[] = [];
  for (let i = 1; i < eq.length; i++) dailyR.push((eq[i]! - eq[i - 1]!) / eq[i - 1]!);
  const m = dailyR.reduce((a, b) => a + b, 0) / Math.max(1, dailyR.length);
  const v = dailyR.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, dailyR.length);
  const sharpe = v > 0 ? (m / Math.sqrt(v)) * Math.sqrt(252) : 0;
  return { totalReturn: totalRet, cagr, sharpe, maxDD, winRate, payoff, trades: trades.length, exposure: exposed / eq.length };
}

function main() {
  const u: Universe = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_universe_kline.json"), "utf-8"));
  const base: Cfg = {
    equity: 1_000_000, maxPositions: 5, perTradeRiskPct: 0.025,
    minTurnoverHkd: 300_000_000, minNewHighsLast20: 2, rsRankTopPct: 0.15,
    maxDaysSinceHigh: 8, atrStopMult: 2.5, chandelierMult: 2.5,
    feeBps: 25, warmupDays: 80,
    entryMode: "pullback", exitOnEma21Break: true, trailingMode: "chandelier", pyramidLayers: 1,
  };

  const variants: Array<{ name: string; cfg: Partial<Cfg> }> = [
    { name: "max-pos 3", cfg: { maxPositions: 3 } },
    { name: "max-pos 3 + RS top 30%", cfg: { maxPositions: 3, rsRankTopPct: 0.30 } },
    { name: "max-pos 3 + wide stop 4ATR", cfg: { maxPositions: 3, atrStopMult: 4.0, chandelierMult: 4.0 } },
    { name: "max-pos 3 + risk 1.5%", cfg: { maxPositions: 3, perTradeRiskPct: 0.015 } },
    { name: "max-pos 2 + risk 2.5%", cfg: { maxPositions: 2 } },
    { name: "max-pos 4 + RS top 25%", cfg: { maxPositions: 4, rsRankTopPct: 0.25 } },
    { name: "RS top 30% + atrStop 3", cfg: { rsRankTopPct: 0.30, atrStopMult: 3.0 } },
    { name: "min-newHighs 3 + max-pos 3", cfg: { maxPositions: 3, minNewHighsLast20: 3 } },
    { name: "max-pos 3 + risk 1.5% + atrStop 3", cfg: { maxPositions: 3, perTradeRiskPct: 0.015, atrStopMult: 3.0, chandelierMult: 3.0 } },
    { name: "★ 最稳: pos2 risk 2% atrStop 3", cfg: { maxPositions: 2, perTradeRiskPct: 0.02, atrStopMult: 3.0, chandelierMult: 3.0 } },
    { name: "★ 平衡: pos3 risk 2% RS25 atrStop 3", cfg: { maxPositions: 3, perTradeRiskPct: 0.02, rsRankTopPct: 0.25, atrStopMult: 3.0, chandelierMult: 3.0 } },
    { name: "★ 进取: pos3 risk 3% RS30 wide", cfg: { maxPositions: 3, perTradeRiskPct: 0.03, rsRankTopPct: 0.30, atrStopMult: 4.0, chandelierMult: 4.0 } },
  ];

  const results: Array<{ name: string; r: BtRes }> = [];
  for (const v of variants) {
    const r = bt(u, { ...base, ...v.cfg });
    results.push({ name: v.name, r });
  }
  console.log("==== Leader-Rider 参数扫描 (18 月真实数据) ====");
  console.log(`Period: ${u.start} → ${u.end}, baseline universe 等权 buy-hold ≈ +70%\n`);
  console.log("Variant".padEnd(48), "Trades", "Ret%", "CAGR%", "Sharpe", "MaxDD%", "WinRate%", "Payoff", "Exposure%");
  console.log("-".repeat(120));
  results.sort((a, b) => b.r.sharpe - a.r.sharpe);
  for (const { name, r } of results) {
    console.log(
      name.padEnd(48),
      String(r.trades).padStart(5),
      (r.totalReturn * 100).toFixed(1).padStart(6),
      (r.cagr * 100).toFixed(1).padStart(6),
      r.sharpe.toFixed(2).padStart(6),
      (r.maxDD * 100).toFixed(1).padStart(7),
      (r.winRate * 100).toFixed(1).padStart(7),
      isFinite(r.payoff) ? r.payoff.toFixed(2).padStart(6) : "  N/A",
      (r.exposure * 100).toFixed(1).padStart(8)
    );
  }

  // 找最佳: maxDD < 15% 且 sharpe 最高
  const eligible = results.filter((x) => x.r.maxDD < 0.15);
  if (eligible.length > 0) {
    eligible.sort((a, b) => b.r.sharpe - a.r.sharpe);
    console.log(`\n>>> 最佳 maxDD<15% 组合: ${eligible[0]!.name} (Sharpe ${eligible[0]!.r.sharpe.toFixed(2)}, MaxDD ${(eligible[0]!.r.maxDD * 100).toFixed(1)}%, Ret ${(eligible[0]!.r.totalReturn * 100).toFixed(1)}%)`);
  } else {
    console.log("\n>>> 无组合满足 maxDD<15%, 需进一步收紧风控或换数据.");
  }
}

main();
