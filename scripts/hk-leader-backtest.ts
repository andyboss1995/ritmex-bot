/**
 * Leader-Rider 子策略回测 (基于 18 个月真实 universe kline 数据).
 *
 * 选股逻辑 (每日盘后扫描):
 *   1. 近 20 日内 60 日新高频次 ≥ N (默认 2)
 *   2. RS rank: 60 日累计涨幅在 universe 中前 X% (默认前 15%)
 *   3. 20 日均成交额 ≥ 阈值 (默认 300M HKD)
 *   4. 距上次新高 ≤ Y 天 (默认 8)
 *
 * 入场 (次日开盘, 防 look-ahead):
 *   - 当日 low ≤ EMA10 ≤ 当日 close (回踩成功)
 *   - 当日 close > EMA21 (趋势未破)
 *   - 仓位 = perTradeRiskPct * equity / (entry - stop)
 *
 * 退出 (按优先级):
 *   1. 收盘 < EMA21 → 次日开盘退
 *   2. 单日跌幅 > 8% → 次日开盘退
 *   3. 价格 < (持仓期最高收盘 - chandelierMult × ATR) → 次日开盘退
 *   4. 触发硬止损 (entry - atrStopMult × entry-day ATR) → 当日按止损价退
 *
 * 用法:
 *   bun run scripts/hk-leader-backtest.ts                  # 默认参数
 *   bun run scripts/hk-leader-backtest.ts --equity 1000000 --max-pos 5
 *   bun run scripts/hk-leader-backtest.ts --compare        # 同时跑 baseline (买入持有 + 等权龙头组合)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; turnover: number; }
interface Entry { symbol: string; name: string; bars: Bar[]; }
interface Universe { start: string; end: string; series: Entry[]; }

interface BtConfig {
  equity: number;
  maxPositions: number;
  perTradeRiskPct: number;
  minTurnoverHkd: number;
  minNewHighsLast20: number;
  rsRankTopPct: number;          // 0.15 = 前 15%
  maxDaysSinceHigh: number;
  atrStopMult: number;
  chandelierMult: number;
  feeBps: number;                // 双边费用 bps (港股印花税 + 佣金 ≈ 25 bps)
  ema10: number;
  ema21: number;
  warmupDays: number;
}

const defaultBtConfig: BtConfig = {
  equity: 1_000_000,
  maxPositions: 5,
  perTradeRiskPct: 0.025,
  minTurnoverHkd: 300_000_000,
  minNewHighsLast20: 2,
  rsRankTopPct: 0.15,
  maxDaysSinceHigh: 8,
  atrStopMult: 2.5,
  chandelierMult: 2.5,
  feeBps: 25,
  ema10: 10,
  ema21: 21,
  warmupDays: 80,
};

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

function atrAt(bars: Bar[], idx: number, period: number): number {
  const start = Math.max(1, idx - period + 1);
  let sum = 0;
  let n = 0;
  for (let i = start; i <= idx; i++) {
    const c = bars[i]!, p = bars[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    n++;
  }
  return n > 0 ? sum / n : NaN;
}

interface Position {
  symbol: string;
  name: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  stopPrice: number;
  highestClose: number;
  atrAtEntry: number;
}

interface Trade {
  symbol: string;
  name: string;
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnl: number;
  pnlPct: number;
  reason: string;
  holdDays: number;
}

interface SymbolPrecomp {
  ema10: number[];
  ema21: number[];
  ret60: number[];        // 每日 60 日累计收益率
  highRolling60: number[]; // 每日过去 60 日 high (不含当日)
  newHighsLast20: number[]; // 每日近 20 日内新高次数
  daysSinceHigh: number[];  // 每日距上次 60 日新高天数
  avgTurnover20: number[];  // 每日 20 日均成交额
}

function precompute(entry: Entry): SymbolPrecomp {
  const bars = entry.bars;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const turnovers = bars.map((b) => b.turnover);
  const ema10 = emaSeries(closes, 10);
  const ema21 = emaSeries(closes, 21);

  const ret60: number[] = [];
  const highRolling60: number[] = [];
  const newHighsLast20: number[] = [];
  const daysSinceHigh: number[] = [];
  const avgTurnover20: number[] = [];

  // 滚动 60 日 high (不含当日, 用于判断 i 日是否新高)
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - 60);
    const window = highs.slice(start, i);
    highRolling60.push(window.length > 0 ? Math.max(...window) : -Infinity);

    const ago = i - 60;
    ret60.push(ago >= 0 ? (closes[i]! - closes[ago]!) / closes[ago]! : NaN);

    const tStart = Math.max(0, i - 19);
    const tWindow = turnovers.slice(tStart, i + 1);
    avgTurnover20.push(tWindow.reduce((a, b) => a + b, 0) / tWindow.length);
  }

  // 近 20 日新高次数 + 距上次新高天数
  for (let i = 0; i < bars.length; i++) {
    let count = 0;
    let lastHighIdx = -1;
    const winStart = Math.max(0, i - 19);
    for (let j = winStart; j <= i; j++) {
      if (j < 60) continue;
      if (bars[j]!.high > highRolling60[j]!) {
        count++;
        lastHighIdx = j;
      }
    }
    newHighsLast20.push(count);
    daysSinceHigh.push(lastHighIdx >= 0 ? i - lastHighIdx : 9999);
  }

  return { ema10, ema21, ret60, highRolling60, newHighsLast20, daysSinceHigh, avgTurnover20 };
}

interface BacktestResult {
  trades: Trade[];
  finalEquity: number;
  startEquity: number;
  totalReturn: number;
  cagr: number;
  maxDrawdown: number;
  winRate: number;
  payoff: number;
  avgWin: number;
  avgLoss: number;
  totalTrades: number;
  sharpe: number;
  equityCurve: Array<{ date: string; equity: number }>;
  exposureRate: number;
}

function runBacktest(universe: Universe, cfg: BtConfig): BacktestResult {
  const entries = universe.series.filter((e) => e.bars.length >= cfg.warmupDays);
  const allDates = entries[0]!.bars.map((b) => b.date);
  const dateIdx = new Map<string, number>();
  allDates.forEach((d, i) => dateIdx.set(d, i));

  // 预计算所有股票
  const precomp = new Map<string, SymbolPrecomp>();
  const barIdx = new Map<string, Map<string, number>>();
  for (const e of entries) {
    precomp.set(e.symbol, precompute(e));
    const m = new Map<string, number>();
    e.bars.forEach((b, i) => m.set(b.date, i));
    barIdx.set(e.symbol, m);
  }

  let equity = cfg.equity;
  const startEquity = cfg.equity;
  const trades: Trade[] = [];
  const equityCurve: Array<{ date: string; equity: number }> = [];
  const positions = new Map<string, Position>();
  let exposedDays = 0;
  let peakEquity = equity;
  let maxDD = 0;

  // 准备每日 RS 排名 (用最 close 60 日 return 全 universe 排名)
  // 直接每日重新算: 速度 OK (185 × 360 = 67k cell)

  for (let dayIdx = cfg.warmupDays; dayIdx < allDates.length - 1; dayIdx++) {
    const today = allDates[dayIdx]!;
    const tomorrow = allDates[dayIdx + 1]!;

    // === 先处理已有仓位的退出 (用次日开盘) ===
    const toExit: Array<{ symbol: string; reason: string; price: number; date: string }> = [];
    for (const [sym, pos] of positions) {
      const e = entries.find((x) => x.symbol === sym)!;
      const idx = barIdx.get(sym)!.get(today);
      if (idx == null) continue;
      const todayBar = e.bars[idx]!;
      const tomorrowBar = e.bars[barIdx.get(sym)!.get(tomorrow)!];
      const pre = precomp.get(sym)!;

      // 更新最高收盘
      if (todayBar.close > pos.highestClose) pos.highestClose = todayBar.close;

      // 优先级 4: 当日 low 触及硬止损
      if (todayBar.low <= pos.stopPrice) {
        toExit.push({ symbol: sym, reason: "stop_loss", price: pos.stopPrice, date: today });
        continue;
      }

      // 单日跌幅 > 8% → 次日开盘
      const yClose = e.bars[idx - 1]?.close ?? todayBar.close;
      const dropPct = (yClose - todayBar.close) / yClose;
      if (dropPct > 0.08) {
        toExit.push({ symbol: sym, reason: "single_day_drop", price: tomorrowBar?.open ?? todayBar.close, date: tomorrow });
        continue;
      }

      // 收盘 < EMA21 → 次日开盘
      if (todayBar.close < pre.ema21[idx]!) {
        toExit.push({ symbol: sym, reason: "below_ema21", price: tomorrowBar?.open ?? todayBar.close, date: tomorrow });
        continue;
      }

      // Chandelier
      const trailingStop = pos.highestClose - pos.atrAtEntry * cfg.chandelierMult;
      if (todayBar.close < trailingStop) {
        toExit.push({ symbol: sym, reason: "chandelier", price: tomorrowBar?.open ?? todayBar.close, date: tomorrow });
        continue;
      }
    }

    for (const ex of toExit) {
      const pos = positions.get(ex.symbol)!;
      const grossPnl = (ex.price - pos.entryPrice) * pos.shares;
      const fee = (ex.price * pos.shares + pos.entryPrice * pos.shares) * (cfg.feeBps / 10000);
      const pnl = grossPnl - fee;
      equity += ex.price * pos.shares - fee / 2; // 卖出回收, 入场时已扣过现金
      const idxOpen = barIdx.get(ex.symbol)!.get(pos.entryDate)!;
      const idxClose = barIdx.get(ex.symbol)!.get(ex.date)!;
      trades.push({
        symbol: ex.symbol, name: pos.name,
        entryDate: pos.entryDate, exitDate: ex.date,
        entryPrice: pos.entryPrice, exitPrice: ex.price,
        shares: pos.shares, pnl, pnlPct: pnl / (pos.entryPrice * pos.shares),
        reason: ex.reason, holdDays: idxClose - idxOpen,
      });
      positions.delete(ex.symbol);
    }

    // === 找今日入场候选 ===
    if (positions.size < cfg.maxPositions) {
      const candidates: Array<{ symbol: string; name: string; ret60: number; entryPrice: number; atr: number; ema21Today: number }> = [];
      for (const e of entries) {
        if (positions.has(e.symbol)) continue;
        const idx = barIdx.get(e.symbol)!.get(today);
        if (idx == null || idx < cfg.warmupDays - 1) continue;
        const pre = precomp.get(e.symbol)!;
        const todayBar = e.bars[idx]!;
        if (pre.avgTurnover20[idx]! < cfg.minTurnoverHkd) continue;
        if (pre.newHighsLast20[idx]! < cfg.minNewHighsLast20) continue;
        if (pre.daysSinceHigh[idx]! > cfg.maxDaysSinceHigh) continue;
        const ema10v = pre.ema10[idx]!;
        const ema21v = pre.ema21[idx]!;
        if (todayBar.close < ema21v) continue;
        // 回踩 EMA10: 当日 low <= ema10 <= close
        if (!(todayBar.low <= ema10v && ema10v <= todayBar.close)) continue;
        if (!Number.isFinite(pre.ret60[idx])) continue;
        candidates.push({
          symbol: e.symbol, name: e.name,
          ret60: pre.ret60[idx]!,
          entryPrice: e.bars[idx + 1]?.open ?? todayBar.close,
          atr: atrAt(e.bars, idx, 14),
          ema21Today: ema21v,
        });
      }

      if (candidates.length > 0) {
        // 按 RS rank 过滤: 今日所有 universe 的 ret60 排名前 rsRankTopPct
        const allRet60: number[] = [];
        for (const e of entries) {
          const idx = barIdx.get(e.symbol)!.get(today);
          if (idx == null) continue;
          const r = precomp.get(e.symbol)!.ret60[idx];
          if (Number.isFinite(r)) allRet60.push(r!);
        }
        allRet60.sort((a, b) => b - a);
        const cutoff = allRet60[Math.floor(allRet60.length * cfg.rsRankTopPct)] ?? -Infinity;
        const passed = candidates.filter((c) => c.ret60 >= cutoff);
        passed.sort((a, b) => b.ret60 - a.ret60);

        for (const c of passed) {
          if (positions.size >= cfg.maxPositions) break;
          if (!Number.isFinite(c.atr) || c.atr <= 0) continue;
          const stop = c.entryPrice - c.atr * cfg.atrStopMult;
          const riskPerShare = c.entryPrice - stop;
          if (riskPerShare <= 0) continue;
          const riskBudget = equity * cfg.perTradeRiskPct;
          const rawShares = riskBudget / riskPerShare;
          const shares = Math.max(0, Math.floor(rawShares / 100) * 100);
          if (shares <= 0) continue;
          const cost = shares * c.entryPrice;
          if (cost > equity * 0.5) continue; // 单笔不超过 50% 资金 (防小账户单股全押)
          const fee = cost * (cfg.feeBps / 10000);
          equity -= cost + fee / 2;
          positions.set(c.symbol, {
            symbol: c.symbol, name: c.name,
            shares, entryPrice: c.entryPrice,
            entryDate: tomorrow,
            stopPrice: stop,
            highestClose: c.entryPrice,
            atrAtEntry: c.atr,
          });
        }
      }
    }

    // 估算市值 + 记权益
    let mtm = 0;
    for (const [sym, pos] of positions) {
      const idx = barIdx.get(sym)!.get(today);
      if (idx == null) continue;
      mtm += entries.find((x) => x.symbol === sym)!.bars[idx]!.close * pos.shares;
    }
    const totalEquity = equity + mtm;
    equityCurve.push({ date: today, equity: totalEquity });
    if (positions.size > 0) exposedDays++;
    if (totalEquity > peakEquity) peakEquity = totalEquity;
    const dd = (peakEquity - totalEquity) / peakEquity;
    if (dd > maxDD) maxDD = dd;
  }

  // 最后一天强制平仓
  const lastDate = allDates[allDates.length - 1]!;
  for (const [sym, pos] of positions) {
    const e = entries.find((x) => x.symbol === sym)!;
    const last = e.bars[e.bars.length - 1]!;
    const grossPnl = (last.close - pos.entryPrice) * pos.shares;
    const fee = (last.close * pos.shares + pos.entryPrice * pos.shares) * (cfg.feeBps / 10000);
    const pnl = grossPnl - fee;
    equity += last.close * pos.shares - fee / 2;
    trades.push({
      symbol: sym, name: pos.name,
      entryDate: pos.entryDate, exitDate: lastDate,
      entryPrice: pos.entryPrice, exitPrice: last.close,
      shares: pos.shares, pnl, pnlPct: pnl / (pos.entryPrice * pos.shares),
      reason: "end_of_data", holdDays: 0,
    });
  }

  const finalEquity = equity;
  const totalReturn = (finalEquity - startEquity) / startEquity;
  const days = allDates.length;
  const years = days / 252;
  const cagr = years > 0 ? Math.pow(finalEquity / startEquity, 1 / years) - 1 : 0;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b.pnl, 0) / losses.length : 0;
  const payoff = avgLoss < 0 ? Math.abs(avgWin / avgLoss) : NaN;
  const exposureRate = exposedDays / equityCurve.length;

  // 简易 Sharpe (日度收益)
  const dailyRets: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    dailyRets.push((equityCurve[i]!.equity - equityCurve[i - 1]!.equity) / equityCurve[i - 1]!.equity);
  }
  const meanR = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
  const varR = dailyRets.reduce((a, b) => a + (b - meanR) ** 2, 0) / dailyRets.length;
  const sharpe = varR > 0 ? (meanR / Math.sqrt(varR)) * Math.sqrt(252) : 0;

  return {
    trades, finalEquity, startEquity, totalReturn, cagr, maxDrawdown: maxDD,
    winRate, payoff, avgWin, avgLoss, totalTrades: trades.length, sharpe,
    equityCurve, exposureRate,
  };
}

function fmt(n: number, digits = 2): string {
  return (n * 100).toFixed(digits) + "%";
}

function main(): void {
  const path = resolve(process.cwd(), "data/hk_universe_kline.json");
  const u: Universe = JSON.parse(readFileSync(path, "utf-8"));
  const cfg: BtConfig = { ...defaultBtConfig };
  const argv = process.argv;
  const eIdx = argv.indexOf("--equity");
  if (eIdx > 0) cfg.equity = Number(argv[eIdx + 1]);
  const mIdx = argv.indexOf("--max-pos");
  if (mIdx > 0) cfg.maxPositions = Number(argv[mIdx + 1]);
  const compare = argv.includes("--compare");

  console.log(`==== HK Leader-Rider Backtest ====`);
  console.log(`Period: ${u.start} → ${u.end}`);
  console.log(`Universe: ${u.series.length} symbols`);
  console.log(`Config: equity=${cfg.equity.toLocaleString()} HKD, maxPos=${cfg.maxPositions}, perTradeRisk=${fmt(cfg.perTradeRiskPct)}, atrStop=${cfg.atrStopMult}×, chandelier=${cfg.chandelierMult}×, fee=${cfg.feeBps}bps`);

  const r = runBacktest(u, cfg);
  console.log("");
  console.log(`总交易: ${r.totalTrades}笔  胜率: ${fmt(r.winRate)}  盈亏比: ${r.payoff.toFixed(2)}  曝险率: ${fmt(r.exposureRate)}`);
  console.log(`总收益: ${fmt(r.totalReturn)}  CAGR: ${fmt(r.cagr)}  Sharpe: ${r.sharpe.toFixed(2)}  最大回撤: ${fmt(r.maxDrawdown)}`);
  console.log(`期末资金: ${r.finalEquity.toLocaleString(undefined, { maximumFractionDigits: 0 })} HKD`);
  console.log(`平均赢: +${r.avgWin.toFixed(0)}  平均亏: ${r.avgLoss.toFixed(0)}`);

  // 退出原因分布
  const exitReasons = new Map<string, number>();
  for (const t of r.trades) exitReasons.set(t.reason, (exitReasons.get(t.reason) ?? 0) + 1);
  console.log(`退出原因: ${[...exitReasons].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // Top 5 winners / losers
  const sorted = [...r.trades].sort((a, b) => b.pnl - a.pnl);
  console.log("\nTop 5 赢家:");
  for (const t of sorted.slice(0, 5)) {
    console.log(`  ${t.entryDate} → ${t.exitDate}  ${t.symbol} ${t.name}  ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}  pnl=${t.pnl.toFixed(0)} (${(t.pnlPct * 100).toFixed(1)}%)  ${t.reason}  ${t.holdDays}d`);
  }
  console.log("\nTop 5 输家:");
  for (const t of sorted.slice(-5).reverse()) {
    console.log(`  ${t.entryDate} → ${t.exitDate}  ${t.symbol} ${t.name}  ${t.entryPrice.toFixed(2)} → ${t.exitPrice.toFixed(2)}  pnl=${t.pnl.toFixed(0)} (${(t.pnlPct * 100).toFixed(1)}%)  ${t.reason}  ${t.holdDays}d`);
  }

  // 持有期分布
  const holdAvg = r.trades.reduce((a, b) => a + b.holdDays, 0) / Math.max(1, r.trades.length);
  console.log(`\n平均持有: ${holdAvg.toFixed(1)}天`);

  // 月度分布
  const byMonth = new Map<string, { pnl: number; trades: number }>();
  for (const t of r.trades) {
    const m = t.exitDate.slice(0, 7);
    const cur = byMonth.get(m) ?? { pnl: 0, trades: 0 };
    cur.pnl += t.pnl;
    cur.trades++;
    byMonth.set(m, cur);
  }
  console.log("\n月度盈亏:");
  for (const [m, v] of [...byMonth.entries()].sort()) {
    const pct = (v.pnl / cfg.equity) * 100;
    console.log(`  ${m}: ${v.trades}笔  ${v.pnl.toFixed(0)} HKD  (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% on initial)`);
  }

  if (compare) {
    // Baseline: 等权买入持有所有有足够数据的 universe (近似 universe-index)
    const eligible = u.series.filter((e) => e.bars.length > cfg.warmupDays);
    const eqRets = eligible.map((e) => {
      const s = e.bars[cfg.warmupDays]!.close;
      const x = e.bars[e.bars.length - 1]!.close;
      return (x - s) / s;
    });
    const avgEqRet = eqRets.reduce((a, b) => a + b, 0) / Math.max(1, eqRets.length);
    console.log(`\n[Baseline] Universe 等权买入持有: ${fmt(avgEqRet)}`);
  }

  // 20k HKD 实盘可行性
  if (cfg.equity > 100_000) {
    console.log("\n==== 20k HKD 小账户可行性诊断 ====");
    const small: BtConfig = { ...cfg, equity: 20_000, maxPositions: 2, perTradeRiskPct: 0.04 };
    const r2 = runBacktest(u, small);
    console.log(`equity=20k, maxPos=2, perTradeRisk=4%`);
    console.log(`  交易: ${r2.totalTrades}笔  胜率: ${fmt(r2.winRate)}  盈亏比: ${r2.payoff.toFixed(2)}`);
    console.log(`  总收益: ${fmt(r2.totalReturn)}  CAGR: ${fmt(r2.cagr)}  maxDD: ${fmt(r2.maxDrawdown)}`);
    console.log(`  期末: ${r2.finalEquity.toFixed(0)} HKD  曝险: ${fmt(r2.exposureRate)}`);
  }
}

main();
