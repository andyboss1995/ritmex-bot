/**
 * Leader-Rider 实盘执行器 (SIMULATE / REAL).
 *
 * 与 hk-momentum-policy 并行运行, 通过 data/state/leader-positions.json 隔离仓位.
 * 不会触碰非本策略持有的标的 (momentum-policy 仓位 + 用户手动持仓).
 *
 * 流程:
 *   1. 启动 FutuTradeBridge → 拉账户与持仓
 *   2. 加载 universe kline + 当日 snapshot, 拼接得到当日为最后一根 bar 的序列
 *   3. 退出检查: 对每只 leader-rider 持仓, 按硬止损 / 单日跌幅 / EMA21 / chandelier 决定卖出
 *   4. 入场扫描: 同一逻辑 hk-leader-backtest.ts (回踩 EMA10 + RS Top 30% + 60 日新高近 8 日)
 *   5. 仓位: 受账户权益 + perTradeRiskPct + lot size 约束, 适配 20k 小账户
 *   6. 下单: SIMULATE 默认 --auto, REAL 需手动 yes 或显式 --i-know-what-i-am-doing
 *
 * 用法:
 *   bun run scripts/hk-leader-live.ts                     # SIMULATE 默认 --auto
 *   bun run scripts/hk-leader-live.ts --no-auto           # 手动确认
 *   FUTU_TRD_ENV=REAL bun run scripts/hk-leader-live.ts   # 实盘 (需手动 yes)
 *   bun run scripts/hk-leader-live.ts --max-pos 2 --risk-pct 0.02
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { FutuTradeBridge } from "../src/strategy/hk-momentum-policy";

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; turnover: number; }
interface Entry { symbol: string; name: string; bars: Bar[]; }
interface Universe { start: string; end: string; series: Entry[]; }
interface Snap { symbol: string; name: string; bars: Bar[]; lastPrice: number; preClose: number; intradayVolume: number; }
interface SnapFile { fetchedAt: string; marketState?: string; snapshots: Snap[]; }

interface LiveCfg {
  maxPositions: number;
  perTradeRiskPct: number;
  rsRankTopPct: number;
  minNewHighsLast20: number;
  maxDaysSinceHigh: number;
  minTurnoverHkd: number;
  atrStopMult: number;
  chandelierMult: number;
  exitOnEma21Break: boolean;
  feeBps: number;
  warmupDays: number;
}

const DEFAULT: LiveCfg = {
  maxPositions: 3,
  perTradeRiskPct: 0.025,
  rsRankTopPct: 0.30,
  minNewHighsLast20: 2,
  maxDaysSinceHigh: 8,
  minTurnoverHkd: 300_000_000,
  atrStopMult: 2.5,
  chandelierMult: 2.5,
  exitOnEma21Break: true,
  feeBps: 25,
  warmupDays: 80,
};

interface LeaderPos {
  symbol: string;
  name: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  stopPrice: number;
  highestClose: number;
  atrAtEntry: number;
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]!];
  for (let i = 1; i < values.length; i++) out.push(values[i]! * k + out[i - 1]! * (1 - k));
  return out;
}

function atrOf(bars: Bar[], period: number): number {
  const n = Math.min(period, bars.length - 1);
  if (n < 2) return NaN;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = bars[i]!, p = bars[i - 1]!;
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / n;
}

interface SymbolView {
  symbol: string;
  name: string;
  bars: Bar[];
  ema10Today: number;
  ema21Today: number;
  ret60: number;
  newHighsLast20: number;
  daysSinceHigh: number;
  avgTurnover20: number;
  atr14: number;
  todayBar: Bar;
}

function buildView(symbol: string, name: string, bars: Bar[]): SymbolView | null {
  if (bars.length < 80) return null;
  const closes = bars.map((b) => b.close);
  const highs = bars.map((b) => b.high);
  const turnovers = bars.map((b) => b.turnover);
  const ema10 = emaSeries(closes, 10);
  const ema21 = emaSeries(closes, 21);
  const lastIdx = bars.length - 1;
  const todayBar = bars[lastIdx]!;
  const ago = lastIdx - 60;
  const ret60 = ago >= 0 ? (closes[lastIdx]! - closes[ago]!) / closes[ago]! : NaN;
  const turn20 = turnovers.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, turnovers.length);
  const atr14 = atrOf(bars, 14);

  // 60 日新高滚动
  let cnt = 0, last = -1;
  for (let j = Math.max(0, lastIdx - 19); j <= lastIdx; j++) {
    if (j < 60) continue;
    const wHigh = Math.max(...highs.slice(Math.max(0, j - 60), j));
    if (bars[j]!.high > wHigh) { cnt++; last = j; }
  }
  return {
    symbol, name, bars, todayBar,
    ema10Today: ema10[lastIdx]!,
    ema21Today: ema21[lastIdx]!,
    ret60,
    newHighsLast20: cnt,
    daysSinceHigh: last >= 0 ? lastIdx - last : 9999,
    avgTurnover20: turn20,
    atr14,
  };
}

function parseArgs() {
  const a = process.argv;
  const num = (flag: string, def: number) => {
    const i = a.indexOf(flag);
    return i > 0 && Number.isFinite(Number(a[i + 1])) ? Number(a[i + 1]) : def;
  };
  return {
    maxPos: num("--max-pos", DEFAULT.maxPositions),
    riskPct: num("--risk-pct", DEFAULT.perTradeRiskPct),
    rsTop: num("--rs-top", DEFAULT.rsRankTopPct),
    auto: !a.includes("--no-auto"),
    minLot: num("--min-lot", 100),
    knowREAL: a.includes("--i-know-what-i-am-doing"),
  };
}

async function ask(q: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { const ans = (await rl.question(q)).trim().toLowerCase(); return ans === "yes" || ans === "y"; }
  finally { rl.close(); }
}

function loadPositions(p: string): LeaderPos[] {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : []; } catch { return []; }
}
function savePositions(p: string, arr: LeaderPos[]): void {
  writeFileSync(p, JSON.stringify(arr, null, 2));
}

async function main(): Promise<void> {
  const env = (process.env.FUTU_TRD_ENV ?? "SIMULATE") as "SIMULATE" | "REAL";
  const host = process.env.FUTU_HOST ?? "127.0.0.1";
  const port = Number(process.env.FUTU_PORT ?? 11111);
  const unlockPwdMd5 = process.env.FUTU_UNLOCK_PWD_MD5;
  if (env === "REAL" && !unlockPwdMd5) { console.error("REAL 必须设置 FUTU_UNLOCK_PWD_MD5"); process.exit(1); }

  const args = parseArgs();
  if (env === "REAL" && args.auto && !args.knowREAL) {
    console.error("REAL 模式不允许 --auto, 必须显式加 --no-auto 或 --i-know-what-i-am-doing");
    process.exit(2);
  }

  const cfg: LiveCfg = {
    ...DEFAULT,
    maxPositions: args.maxPos,
    perTradeRiskPct: args.riskPct,
    rsRankTopPct: args.rsTop,
  };

  const stateDir = resolve(process.cwd(), "data/state");
  mkdirSync(stateDir, { recursive: true });
  const reportsDir = resolve(process.cwd(), "data/reports");
  mkdirSync(reportsDir, { recursive: true });
  const posPath = resolve(stateDir, "leader-positions.json");
  const today = new Date().toISOString().slice(0, 10);
  const cycleLog = resolve(reportsDir, `leader-${today}.jsonl`);

  const universePath = resolve(process.cwd(), "data/hk_universe_kline.json");
  const snapPath = resolve(process.cwd(), "data/hk_snapshot.json");
  if (!existsSync(universePath)) { console.error(`缺 ${universePath}, 先跑 futu_pull_universe.py`); process.exit(3); }
  if (!existsSync(snapPath)) { console.error(`缺 ${snapPath}, 先跑 futu_pull_snapshot.py`); process.exit(3); }

  const u: Universe = JSON.parse(readFileSync(universePath, "utf8"));
  const sf: SnapFile = JSON.parse(readFileSync(snapPath, "utf8"));
  const snapMap = new Map(sf.snapshots.map((s) => [s.symbol, s] as const));

  console.log(`==== HK Leader-Rider 实盘 (${env}) ====`);
  console.log(`Universe: ${u.series.length} | Snapshot: ${sf.fetchedAt} | Market: ${sf.marketState ?? "?"}`);
  console.log(`Cfg: maxPos=${cfg.maxPositions} risk=${(cfg.perTradeRiskPct * 100).toFixed(1)}% rsTop=${(cfg.rsRankTopPct * 100).toFixed(0)}% atrStop=${cfg.atrStopMult}× chandelier=${cfg.chandelierMult}×`);

  const bridge = new FutuTradeBridge({
    daemonScript: resolve(process.cwd(), "scripts/futu_trade_daemon.py"),
    host, port, env, market: "HK", unlockPwdMd5,
    onLog: (l) => process.stderr.write(`${l}\n`),
  });
  await bridge.start();
  const account = await bridge.getAccount();
  const brokerPositions = await bridge.getPositions();
  console.log(`账户: 总 ${account.totalAssets.toFixed(0)} ${account.currency} | 现金 ${account.cash.toFixed(0)} | 市值 ${account.marketVal.toFixed(0)}`);

  const managed = loadPositions(posPath);
  const managedSet = new Set(managed.map((m) => m.symbol));
  const brokerMap = new Map(brokerPositions.map((p) => [p.symbol, p] as const));
  // 清理对账: 若 broker 已无对应仓位 (用户手动卖了 / 实际未成交), 移除
  for (let i = managed.length - 1; i >= 0; i--) {
    const m = managed[i]!;
    const b = brokerMap.get(m.symbol);
    if (!b || b.qty < m.shares * 0.5) {
      console.log(`[reconcile] ${m.symbol} 已不在持仓 (broker qty=${b?.qty ?? 0}), 移除策略管理.`);
      managed.splice(i, 1);
    } else {
      // 同步实际可卖数量
      m.shares = Math.min(m.shares, b.canSellQty);
    }
  }

  // === 1. 拼接今日 bar 到 universe 历史, 构造 view ===
  const symbolViews = new Map<string, SymbolView>();
  for (const e of u.series) {
    const snap = snapMap.get(e.symbol);
    let bars: Bar[];
    if (snap && snap.bars.length > 0) {
      const lastSnap = snap.bars[snap.bars.length - 1]!;
      // snapshot 自带最近若干 bar, 直接用 union
      const histDates = new Set(e.bars.map((b) => b.date));
      const merged = [...e.bars];
      for (const sb of snap.bars) if (!histDates.has(sb.date)) merged.push(sb);
      // 如 lastPrice 与最后一根 bar close 不同 (盘中), 用 lastPrice 当今日 close
      if (snap.lastPrice && merged.length > 0) {
        const last = merged[merged.length - 1]!;
        const todayDate = sf.fetchedAt.slice(0, 10);
        if (last.date !== todayDate) {
          merged.push({
            date: todayDate,
            open: snap.preClose ?? last.close,
            high: Math.max(snap.lastPrice, last.high),
            low: Math.min(snap.lastPrice, last.low),
            close: snap.lastPrice,
            volume: snap.intradayVolume ?? last.volume,
            turnover: (snap.intradayVolume ?? last.volume) * snap.lastPrice,
          });
        }
      }
      bars = merged;
    } else {
      bars = e.bars;
    }
    const v = buildView(e.symbol, e.name, bars);
    if (v) symbolViews.set(e.symbol, v);
  }

  console.log(`\n候选基础数据就绪: ${symbolViews.size} / ${u.series.length}`);

  // === 2. 退出检查 ===
  const exitDecisions: Array<{ pos: LeaderPos; reason: string; price: number }> = [];
  for (const m of managed) {
    const v = symbolViews.get(m.symbol);
    if (!v) continue;
    if (v.todayBar.close > m.highestClose) m.highestClose = v.todayBar.close;
    const reasons: string[] = [];
    if (v.todayBar.low <= m.stopPrice) reasons.push(`hard_stop@${m.stopPrice.toFixed(2)}`);
    const yClose = v.bars[v.bars.length - 2]?.close ?? v.todayBar.close;
    if ((yClose - v.todayBar.close) / yClose > 0.08) reasons.push(`single_drop_${(((yClose - v.todayBar.close) / yClose) * 100).toFixed(1)}%`);
    if (cfg.exitOnEma21Break && v.todayBar.close < v.ema21Today) reasons.push(`below_ema21`);
    const trail = m.highestClose - m.atrAtEntry * cfg.chandelierMult;
    if (v.todayBar.close < trail) reasons.push(`chandelier@${trail.toFixed(2)}`);
    if (reasons.length > 0) {
      exitDecisions.push({ pos: m, reason: reasons.join("|"), price: v.todayBar.close });
    }
  }

  // === 3. 入场扫描 ===
  const slotsLeft = Math.max(0, cfg.maxPositions - managed.length + exitDecisions.length);
  const candidates: Array<{ v: SymbolView; entry: number; stop: number; shares: number; cost: number }> = [];
  const allRet60: number[] = [];
  for (const v of symbolViews.values()) if (Number.isFinite(v.ret60)) allRet60.push(v.ret60);
  allRet60.sort((a, b) => b - a);
  const cutoff = allRet60[Math.floor(allRet60.length * cfg.rsRankTopPct)] ?? -Infinity;
  const totalEquity = account.totalAssets;

  if (slotsLeft > 0) {
    for (const v of symbolViews.values()) {
      if (managedSet.has(v.symbol)) continue;
      if (brokerMap.has(v.symbol)) continue; // 已有非本策略持仓不重复入场
      if (v.avgTurnover20 < cfg.minTurnoverHkd) continue;
      if (v.newHighsLast20 < cfg.minNewHighsLast20) continue;
      if (v.daysSinceHigh > cfg.maxDaysSinceHigh) continue;
      if (v.todayBar.close < v.ema21Today) continue;
      if (!(v.todayBar.low <= v.ema10Today && v.ema10Today <= v.todayBar.close)) continue;
      if (!Number.isFinite(v.ret60) || v.ret60 < cutoff) continue;
      if (!Number.isFinite(v.atr14) || v.atr14 <= 0) continue;
      const entry = v.todayBar.close;
      const stop = entry - v.atr14 * cfg.atrStopMult;
      const risk = entry - stop;
      if (risk <= 0) continue;
      const budget = totalEquity * cfg.perTradeRiskPct;
      const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
      if (shares <= 0) continue;
      const cost = shares * entry;
      if (cost > account.cash * 0.95) continue;
      candidates.push({ v, entry, stop, shares, cost });
    }
    candidates.sort((a, b) => b.v.ret60 - a.v.ret60);
  }

  // === 4. 显示决策 ===
  console.log(`\n--- 退出决策 (${exitDecisions.length}) ---`);
  for (const e of exitDecisions) {
    console.log(`  SELL ${e.pos.symbol} ${e.pos.name}  ${e.pos.shares} 股  当前 ${e.price.toFixed(2)} (入 ${e.pos.entryPrice.toFixed(2)})  原因: ${e.reason}`);
  }
  console.log(`\n--- 入场候选 (${candidates.length}, 取前 ${slotsLeft}) ---`);
  for (const c of candidates.slice(0, slotsLeft)) {
    console.log(`  BUY ${c.v.symbol} ${c.v.name}  ${c.shares} 股 @ ${c.entry.toFixed(2)}  止损 ${c.stop.toFixed(2)} (-${(((c.entry - c.stop) / c.entry) * 100).toFixed(1)}%)  成本 ${c.cost.toFixed(0)} HKD  RS=${(c.v.ret60 * 100).toFixed(0)}%  newHighs=${c.v.newHighsLast20}`);
  }
  if (exitDecisions.length === 0 && candidates.length === 0) {
    console.log("\n本轮无操作.");
    appendFileSync(cycleLog, JSON.stringify({ ts: new Date().toISOString(), action: "noop" }) + "\n");
    await bridge.stop();
    return;
  }

  if (!args.auto || env === "REAL") {
    const ok = await ask("\n输入 'yes' 执行: ");
    if (!ok) { console.log("已取消."); await bridge.stop(); return; }
  } else {
    console.log("\n[--auto] 自动确认.");
  }

  // === 5. 执行 ===
  // 先卖
  const cycleResult: Record<string, unknown> = { ts: new Date().toISOString(), exits: [], entries: [] };
  for (const e of exitDecisions) {
    try {
      const r = await bridge.submitMarketSell(e.pos.symbol, e.pos.shares);
      console.log(`  ✓ SELL ${e.pos.symbol} x${e.pos.shares}  order=${r.orderId}`);
      (cycleResult.exits as unknown[]).push({ symbol: e.pos.symbol, shares: e.pos.shares, orderId: r.orderId, reason: e.reason });
      const idx = managed.findIndex((m) => m.symbol === e.pos.symbol);
      if (idx >= 0) managed.splice(idx, 1);
    } catch (err) {
      console.error(`  ✗ SELL ${e.pos.symbol}:`, err instanceof Error ? err.message : err);
    }
  }
  // 再买 (限 slot)
  for (const c of candidates.slice(0, slotsLeft)) {
    if (managed.length >= cfg.maxPositions) break;
    try {
      const r = await bridge.submitMarketBuy(c.v.symbol, c.shares);
      const filledPrice = r.filledPrice > 0 ? r.filledPrice : c.entry;
      console.log(`  ✓ BUY ${c.v.symbol} x${c.shares}  order=${r.orderId}  filled@${filledPrice}`);
      (cycleResult.entries as unknown[]).push({ symbol: c.v.symbol, shares: c.shares, orderId: r.orderId, entry: filledPrice });
      managed.push({
        symbol: c.v.symbol, name: c.v.name,
        shares: c.shares, entryPrice: filledPrice,
        entryDate: today,
        stopPrice: c.stop,
        highestClose: filledPrice,
        atrAtEntry: c.v.atr14,
      });
    } catch (err) {
      console.error(`  ✗ BUY ${c.v.symbol}:`, err instanceof Error ? err.message : err);
    }
  }

  savePositions(posPath, managed);
  appendFileSync(cycleLog, JSON.stringify(cycleResult) + "\n");
  console.log(`\n执行完成. 当前管理仓位 ${managed.length}/${cfg.maxPositions}, 状态保存于 ${posPath}`);

  await bridge.stop();
}

main().catch((e) => { console.error("leader-live failed:", e); process.exit(1); });
