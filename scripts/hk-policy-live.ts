/**
 * 实盘 (SIMULATE / REAL) 端到端执行器:
 *   1. 通过 Python daemon 连 OpenD, 解锁交易 (REAL 时)
 *   2. 拉真实持仓 + 账户权益, 同步 universe 快照
 *   3. 跑 engine 给出建议
 *   4. 显示建议 + 等用户输入 'yes' 才下单
 *   5. 下单成功后挂 ATR 止损单
 *
 * 用法:
 *   先确保 OpenD 在跑, 然后:
 *     bun run scripts/hk-policy-live.ts          # SIMULATE
 *     FUTU_TRD_ENV=REAL bun run scripts/hk-policy-live.ts  # 实盘 (需要 FUTU_UNLOCK_PWD_MD5)
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { execSync } from "node:child_process";
import {
  AkshareNewsGrabber,
  type DecisionContext,
  type DecisionExecutor,
  FutuTradeBridge,
  HkMomentumPolicyEngineEntity,
  type HkMomentumPolicyConfig,
  aggressiveConfig,
  DefaultDecisionExecutor,
  type MomentumSignal,
  type NewsItem,
  type PolicyAssessment,
  resolveStops,
  type SymbolSnapshot,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";
import type { MarketDataSource } from "../src/strategy/hk-momentum-policy/market-data";

interface SnapshotFile { fetchedAt: string; marketState?: string; snapshots: SymbolSnapshot[]; }

class FileSnapshotSource implements MarketDataSource {
  constructor(private readonly snapshots: SymbolSnapshot[]) {}
  async loadSnapshots(symbols: string[]): Promise<SymbolSnapshot[]> {
    const set = new Set(symbols);
    return this.snapshots.filter((s) => set.has(s.symbol));
  }
  async loadNews(): Promise<NewsItem[]> { return []; }
}

function applySectorCap(sig: MomentumSignal, sc: Map<string, number>, ctx: DecisionContext): boolean {
  const secs = ctx.symbolSectors?.get(sig.symbol) ?? [];
  const cap = ctx.config.maxPositionsPerSector;
  if (cap > 0 && secs.some((s) => (sc.get(s) ?? 0) >= cap)) return false;
  for (const s of secs) sc.set(s, (sc.get(s) ?? 0) + 1);
  return true;
}

class CatalystExecutor implements DecisionExecutor {
  constructor(private readonly mode: "off" | "medium" | "strong") {}
  async decide(signals: MomentumSignal[], assessments: PolicyAssessment[], ctx: DecisionContext): Promise<TradeDecision[]> {
    const slots = Math.max(0, ctx.config.maxPositions - ctx.openSymbols.length);
    if (slots <= 0) return [];
    const symbolCat = new Map<string, PolicyAssessment[]>();
    if (this.mode !== "off") {
      for (const a of assessments) {
        if (this.mode === "strong" && a.strength !== "strong") continue;
        if (this.mode === "medium" && a.strength !== "strong" && a.strength !== "medium") continue;
        for (const s of a.beneficiarySymbols) {
          if (!symbolCat.has(s)) symbolCat.set(s, []);
          symbolCat.get(s)!.push(a);
        }
      }
    }
    const sc = new Map(ctx.openSectorCounts ?? new Map<string, number>());
    const out: TradeDecision[] = [];
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
      const cats = symbolCat.get(sig.symbol) ?? [];
      if (this.mode !== "off" && cats.length === 0) continue;
      if (!applySectorCap(sig, sc, ctx)) continue;
      const { stopLoss, takeProfit } = resolveStops(sig, ctx.config);
      const risk = sig.lastPrice - stopLoss;
      if (risk <= 0) continue;
      const budget = Math.min(ctx.totalEquityHkd * ctx.config.perTradeRiskPct, ctx.riskBudgetHkd);
      const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
      if (shares <= 0) continue;
      out.push({
        symbol: sig.symbol, name: sig.name, action: "enter",
        entryPrice: sig.lastPrice, stopLoss, takeProfit,
        trailingMa: ctx.config.trailingMa,
        positionSizeShares: shares, positionSizeNotional: shares * sig.lastPrice,
        reason: `${this.mode}; 量比${sig.volumeRatio.toFixed(2)} ${sig.breakoutType} RSI${sig.rsi.toFixed(1)}`,
        catalysts: cats, signal: sig,
      });
    }
    return out;
  }
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await rl.question(prompt)).trim().toLowerCase();
  rl.close();
  return ans === "yes" || ans === "y";
}

function isAutoMode(): boolean {
  return process.argv.includes("--auto") || process.argv.includes("--yes") || process.env.HK_AUTO_CONFIRM === "1";
}

interface ManagedPosition {
  symbol: string;
  name: string;
  shares: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
  reason: string;
}

function loadManaged(p: string): ManagedPosition[] {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as ManagedPosition[] : []; } catch { return []; }
}

function saveManaged(p: string, arr: ManagedPosition[]): void {
  writeFileSync(p, JSON.stringify(arr, null, 2));
}

function appendCycleLog(jsonlPath: string, payload: Record<string, unknown>): void {
  appendFileSync(jsonlPath, JSON.stringify(payload) + "\n");
}

function writeDailyReport(mdPath: string, today: string, lines: string[]): void {
  const header = `# HK Momentum + Policy 模拟盘日报 ${today}\n更新时间: ${new Date().toISOString()}\n`;
  writeFileSync(mdPath, header + "\n" + lines.join("\n"));
}

interface DailySummaryInput {
  mdPath: string;
  today: string;
  account: { totalAssets: number; cash: number; marketVal: number; currency: string };
  positions: Array<{ symbol: string; name: string; qty: number; costPrice: number; currentPrice: number; plRatio: number }>;
  managed: ManagedPosition[];
  jsonlPath: string;
}

function writeDailySummary(inp: DailySummaryInput): void {
  const lines: string[] = [];
  // 汇总当日 cycles
  let cycles = 0;
  let entries = 0;
  let exits = 0;
  let realizedPnl = 0;
  try {
    if (existsSync(inp.jsonlPath)) {
      const raw = readFileSync(inp.jsonlPath, "utf8").split("\n").filter(Boolean);
      cycles = raw.length;
      for (const line of raw) {
        try {
          const r = JSON.parse(line);
          if (Array.isArray(r.executions)) entries += r.executions.length;
          if (Array.isArray(r.managedExits)) {
            for (const e of r.managedExits) {
              exits++;
              if (typeof e.pnlHkd === "number") realizedPnl += e.pnlHkd;
            }
          }
        } catch {}
      }
    }
  } catch {}

  lines.push("## 1. 账户");
  lines.push(`- 总资产: ${inp.account.totalAssets.toFixed(0)} ${inp.account.currency} | 现金: ${inp.account.cash.toFixed(0)} | 持仓市值: ${inp.account.marketVal.toFixed(0)}`);
  lines.push("");
  lines.push("## 2. 当日统计");
  lines.push(`- 扫描轮次: ${cycles}`);
  lines.push(`- 策略入场笔数: ${entries}`);
  lines.push(`- 止损/止盈触发: ${exits}`);
  lines.push(`- 已实现PnL (策略管理): ${realizedPnl.toFixed(0)} HKD`);
  lines.push("");
  lines.push("## 3. 当前持仓 (账户)");
  if (!inp.positions.length) lines.push("- 无");
  for (const p of inp.positions) {
    lines.push(`- ${p.symbol} ${p.name}: ${p.qty} 股 @ 成本 ${p.costPrice.toFixed(3)} 现价 ${p.currentPrice.toFixed(3)} (P&L ${p.plRatio.toFixed(2)}%)`);
  }
  lines.push("");
  lines.push("## 4. 策略管理中的仓位 (有 SL/TP)");
  if (!inp.managed.length) lines.push("- 无");
  for (const m of inp.managed) {
    lines.push(`- ${m.symbol} ${m.name}: ${m.shares} 股 @ ${m.entryPrice.toFixed(3)} | SL ${m.stopLoss.toFixed(3)} | TP ${m.takeProfit.toFixed(3)} | 开于 ${m.openedAt}`);
  }
  writeDailyReport(inp.mdPath, inp.today, lines);
}

async function main(): Promise<void> {
  const env = (process.env.FUTU_TRD_ENV ?? "SIMULATE") as "SIMULATE" | "REAL";
  const host = process.env.FUTU_HOST ?? "127.0.0.1";
  const port = Number(process.env.FUTU_PORT ?? 11111);
  const market = (process.env.FUTU_TRD_MARKET ?? "HK") as "HK";
  const unlockPwdMd5 = process.env.FUTU_UNLOCK_PWD_MD5;
  if (env === "REAL" && !unlockPwdMd5) {
    console.error("REAL 模式必须设置 FUTU_UNLOCK_PWD_MD5");
    process.exit(1);
  }

  const snapPath = resolve(process.cwd(), process.env.HK_SNAPSHOT_CACHE ?? "data/hk_snapshot.json");
  const newsCache = resolve(process.cwd(), process.env.AKSHARE_NEWS_CACHE ?? "data/hk_news_live.json");
  const refreshScript = resolve(process.cwd(), "scripts/akshare_pull_news_realtime.py");
  const daemonScript = resolve(process.cwd(), "scripts/futu_trade_daemon.py");
  const watch = process.argv.includes("--watch");
  const ivIdx = process.argv.indexOf("--interval-minutes");
  const intervalMinutes = Number.isFinite(Number(process.env.HK_WATCH_INTERVAL_MIN))
    ? Number(process.env.HK_WATCH_INTERVAL_MIN)
    : ivIdx >= 0 && Number.isFinite(Number(process.argv[ivIdx + 1]))
      ? Number(process.argv[ivIdx + 1])
      : 30;
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const holidaysSet = new Set((process.env.HK_HOLIDAYS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isWeekend = (d: Date) => d.getDay() === 0 || d.getDay() === 6;
  const ymd = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset()*60_000).toISOString().slice(0,10);

  console.log(`==== HK Momentum + Policy 实盘执行器 ====`);
  console.log(`模式: ${env} | OpenD: ${host}:${port} | 市场: ${market}`);

  // Bridge 启动
  const bridge = new FutuTradeBridge({
    daemonScript, host, port, env, market, unlockPwdMd5,
    onLog: (l) => console.error(l),
  });
  await bridge.start();
  console.log("Futu daemon 就绪.");

  try {
    const reportsDir = resolve(process.cwd(), "data/reports");
    const stateDir = resolve(process.cwd(), "data/state");
    mkdirSync(reportsDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    const managedPath = resolve(stateDir, "managed-positions.json");

    for (;;) {
      const now = new Date();
      const today = ymd(now);
      const jsonlPath = resolve(reportsDir, `${today}.jsonl`);
      const mdPath = resolve(reportsDir, `${today}.md`);
      const forceRun = process.env.HK_FORCE_RUN === "1";
      const skipDay = !forceRun && (isWeekend(now) || holidaysSet.has(today));
      if (skipDay) {
        console.log(`[watch] 非交易日 ${today}, 休眠 ${Math.round(intervalMs/60000)} 分钟`);
        if (!watch) break;
        await sleep(intervalMs);
        continue;
      }

      try {
        execSync(`python3 scripts/futu_pull_snapshot.py --universe data/hk_universe_kline.json --bars 60 --out ${snapPath} 2>&1`, { stdio: "inherit" });
      } catch {}
      try {
        execSync(`python3 scripts/akshare_pull_news_realtime.py --universe data/hk_universe_kline.json --out ${newsCache} --lookback-hours 48 2>&1`, { stdio: "inherit" });
      } catch {}

      const account = await bridge.getAccount();
      console.log(`\n账户: 总资产=${account.totalAssets.toFixed(0)} ${account.currency} | 现金=${account.cash.toFixed(0)} | 持仓市值=${account.marketVal.toFixed(0)}`);
      const positions = await bridge.getPositions();
      console.log(`当前持仓: ${positions.length} 只`);
      for (const p of positions) {
        console.log(`  ${p.symbol} ${p.name}: ${p.qty} 股 @ 成本 ${p.costPrice.toFixed(3)} 现价 ${p.currentPrice.toFixed(3)} (P&L ${p.plRatio.toFixed(2)}%)`);
      }

      const snapData: SnapshotFile = JSON.parse(readFileSync(snapPath, "utf8"));
      console.log(`\nuniverse 快照: ${snapData.snapshots.length} 只 (fetchedAt=${snapData.fetchedAt})`);
      const open = typeof snapData.marketState === "string" ? /TRADING|OPEN/i.test(snapData.marketState) : true;
      if (!open) {
        console.log(`[watch] 市场未开盘 (${snapData.marketState ?? "unknown"}), 等待 ${Math.round(intervalMs/60000)} 分钟`);
        appendCycleLog(jsonlPath, {
          ts: new Date().toISOString(), env, account,
          marketState: snapData.marketState ?? null,
          positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, costPrice: p.costPrice, currentPrice: p.currentPrice, plRatio: p.plRatio })),
          note: "market_closed",
        });
        writeDailySummary({ mdPath, today, account, positions, managed: loadManaged(managedPath), jsonlPath });
        if (!watch) break;
        await sleep(intervalMs);
        continue;
      }

      // ====== SIM 本地止损管理 ======
      const managedExits: Array<{ symbol: string; name: string; shares: number; reason: string; price: number; orderId?: string; pnlHkd: number }> = [];
      let managed = loadManaged(managedPath);
      if (managed.length) {
        const priceBy = new Map(positions.map((p) => [p.symbol, p.currentPrice] as const));
        const heldQty = new Map(positions.map((p) => [p.symbol, p.qty] as const));
        const remaining: ManagedPosition[] = [];
        for (const m of managed) {
          const px = priceBy.get(m.symbol);
          const qty = heldQty.get(m.symbol) ?? 0;
          if (!px || qty <= 0) continue;
          const exitShares = Math.min(qty, m.shares);
          const triggerSL = m.stopLoss > 0 && px <= m.stopLoss;
          const triggerTP = m.takeProfit > 0 && px >= m.takeProfit;
          if (triggerSL || triggerTP) {
            const reason = triggerSL ? "SL" : "TP";
            try {
              const sell = await bridge.submitMarketSell(m.symbol, exitShares);
              const filled = Number.isFinite(sell.filledPrice) && sell.filledPrice > 0 ? sell.filledPrice : px;
              const pnl = (filled - m.entryPrice) * exitShares;
              managedExits.push({ symbol: m.symbol, name: m.name, shares: exitShares, reason, price: filled, orderId: sell.orderId, pnlHkd: pnl });
              console.log(`  🚪 EXIT(${reason}) ${m.symbol} ${exitShares} @ ${filled.toFixed(3)} → orderId=${sell.orderId} (PnL ${pnl.toFixed(0)})`);
            } catch (e) {
              console.error(`  ❌ EXIT ${m.symbol} 失败: ${(e as Error).message}`);
              remaining.push(m);
            }
          } else {
            remaining.push(m);
          }
        }
        managed = remaining;
        saveManaged(managedPath, managed);
      }

      const symbolSectors = new Map<string, string[]>();
      try {
        const histNews = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
        for (const [sym, items] of Object.entries(histNews.bySymbol as Record<string, NewsItem[]>)) {
          const set = new Set<string>();
          for (const it of items) for (const sec of it.sectors ?? []) set.add(sec);
          if (set.size > 0) symbolSectors.set(sym, Array.from(set));
        }
      } catch {}

      const broadSymbol = process.env.HK_BROAD_SYMBOL;
      const cfg: Partial<HkMomentumPolicyConfig> = {
        ...aggressiveConfig,
        ...(broadSymbol ? { broadMarketSymbol: broadSymbol } : {}),
      };

      const maxPosEnv = Number(process.env.HK_MAX_POSITIONS ?? "");
      if (Number.isFinite(maxPosEnv) && maxPosEnv > 0) {
        (cfg as HkMomentumPolicyConfig).maxPositions = maxPosEnv;
      }
      const riskPctEnv = Number(process.env.HK_PER_TRADE_RISK_PCT ?? "");
      if (Number.isFinite(riskPctEnv) && riskPctEnv > 0 && riskPctEnv < 1) {
        (cfg as HkMomentumPolicyConfig).perTradeRiskPct = riskPctEnv;
      }
      const dailyCapEnv = Number(process.env.HK_DAILY_RISK_CAP_PCT ?? "");
      if (Number.isFinite(dailyCapEnv) && dailyCapEnv > 0 && dailyCapEnv < 1) {
        (cfg as HkMomentumPolicyConfig).dailyRiskCapPct = dailyCapEnv;
      }
      const nocVolEnv = Number(process.env.HK_NO_CATALYST_VOLUME ?? "");
      if (Number.isFinite(nocVolEnv) && nocVolEnv > 0) {
        (cfg as HkMomentumPolicyConfig).noCatalystVolumeMultiplier = nocVolEnv;
      }
      const nocBothEnv = process.env.HK_NO_CATALYST_BOTH;
      if (nocBothEnv === "0") (cfg as HkMomentumPolicyConfig).noCatalystBreakoutMustBeBoth = false;
      if (nocBothEnv === "1") (cfg as HkMomentumPolicyConfig).noCatalystBreakoutMustBeBoth = true;
      const volMultEnv = Number(process.env.HK_VOLUME_MULTIPLIER ?? "");
      if (Number.isFinite(volMultEnv) && volMultEnv > 0) {
        (cfg as HkMomentumPolicyConfig).volumeMultiplier = volMultEnv;
      }
      const sectorCapEnv = Number(process.env.HK_MAX_POSITIONS_PER_SECTOR ?? "");
      if (Number.isFinite(sectorCapEnv) && sectorCapEnv >= 0) {
        (cfg as HkMomentumPolicyConfig).maxPositionsPerSector = sectorCapEnv;
      }
      const requireMarketEnv = process.env.HK_REQUIRE_MARKET_ABOVE;
      if (requireMarketEnv === "0") (cfg as HkMomentumPolicyConfig).requireMarketAboveSma = false;
      if (requireMarketEnv === "1") (cfg as HkMomentumPolicyConfig).requireMarketAboveSma = true;

      const engine = new HkMomentumPolicyEngineEntity({
        marketData: new FileSnapshotSource(snapData.snapshots),
        newsGrabber: new AkshareNewsGrabber({ cachePath: newsCache, refreshScript, maxStaleMinutes: 15 }),
        decisionExecutor: new DefaultDecisionExecutor(),
        symbolSectors, config: cfg,
      });

      const equityOverride = Number(process.env.HK_EQUITY_HKD ?? "");
      const totalEquity = Number.isFinite(equityOverride) && equityOverride > 0 ? equityOverride : account.totalAssets;
      const ignoreOpen = process.env.HK_IGNORE_OPEN_POSITIONS === "1";
      const result = await engine.run({
        universe: snapData.snapshots.map((s) => s.symbol),
        account: {
          totalEquityHkd: totalEquity,
          realizedPnlToday: 0,
          realizedPnlHistory: [],
          peakEquityHkd: totalEquity,
        },
        positions: (ignoreOpen ? [] : positions).map((p) => ({
          symbol: p.symbol, name: p.name, side: "long",
          entryPrice: p.costPrice, stopLoss: 0, takeProfit: 0, shares: p.qty,
          openedAt: new Date().toISOString(), partialTaken: false, trailingHigh: p.currentPrice,
        })),
        lookbackHours: 36,
      });

      console.log(`\n## 引擎建议`);
      console.log(`  信号: ${result.signals.length} | 新闻: ${result.news.length} | 评估: ${result.assessments.filter(a=>a.strength==='strong').length} strong`);
      if (result.riskGateReason) {
        console.log(`  ⚠️  风控拦截: ${result.riskGateReason}`);
      }
      if (result.decisions.length === 0) {
        console.log(`  无入场建议.`);
        appendCycleLog(jsonlPath, {
          ts: new Date().toISOString(), env, account,
          positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, costPrice: p.costPrice, currentPrice: p.currentPrice, plRatio: p.plRatio })),
          signals: result.signals.length, newsCount: result.news.length, strongCount: result.assessments.filter(a=>a.strength==='strong').length,
          riskGate: result.riskGateReason ?? null, decisions: [], executions: [], managedExits, managedOpen: managed.length,
        });
        writeDailySummary({ mdPath, today, account, positions, managed, jsonlPath });
        if (!watch) break;
        await sleep(intervalMs);
        continue;
      }

      console.log(`\n## ${result.decisions.length} 笔候选订单 (${env}):`);
      for (const d of result.decisions) {
        console.log(`  📈 ${d.symbol} ${d.name}: ${d.positionSizeShares} 股 @ 市价 ~${d.entryPrice.toFixed(3)} = ${d.positionSizeNotional.toFixed(0)} HKD`);
        console.log(`     止损 ${d.stopLoss.toFixed(3)} (-${(((d.entryPrice-d.stopLoss)/d.entryPrice)*100).toFixed(2)}%) | 止盈 ${d.takeProfit.toFixed(3)} (+${(((d.takeProfit-d.entryPrice)/d.entryPrice)*100).toFixed(2)}%)`);
        console.log(`     ${d.reason}`);
      }

      let ok: boolean;
      if (isAutoMode()) {
        if (env === "REAL") {
          console.error("❌ REAL 模式禁止 --auto 自动提交; 必须人工 confirm. 退出.");
          break;
        }
        console.log(`\n[AUTO] SIMULATE 模式自动提交 ${result.decisions.length} 笔订单`);
        ok = true;
      } else {
        ok = await confirm(`\n确认提交以上 ${result.decisions.length} 笔订单? (yes/N): `);
      }
      if (!ok) {
        console.log("已取消, 不下单.");
        if (!watch) break;
        await sleep(intervalMs);
        continue;
      }

      console.log(`\n## 开始下单 (${env})`);
      const executions: Array<{ symbol: string; name: string; shares: number; orderId: string; filledPrice: number; stopOrderId?: string; stopFallback: boolean }> = [];
      for (const d of result.decisions) {
        try {
          const buy = await bridge.submitMarketBuy(d.symbol, d.positionSizeShares);
          console.log(`  ✅ BUY  ${d.symbol} ${d.positionSizeShares} → orderId=${buy.orderId} fill=${buy.filledPrice}`);
          let stopOrderId: string | undefined;
          let stopFallback = false;
          try {
            const stop = await bridge.submitStopLoss(d.symbol, d.positionSizeShares, d.stopLoss);
            stopOrderId = stop.orderId;
            console.log(`  ✅ STOP ${d.symbol} @ ${d.stopLoss.toFixed(3)} → orderId=${stop.orderId}`);
          } catch (e) {
            stopFallback = true;
            console.error(`  ⚠️  STOP ${d.symbol} 不支持(SIM), 由本地止损管理接管: ${(e as Error).message}`);
          }
          executions.push({
            symbol: d.symbol, name: d.name, shares: d.positionSizeShares,
            orderId: buy.orderId, filledPrice: Number(buy.filledPrice) || d.entryPrice,
            stopOrderId, stopFallback,
          });
          // 记录到本地 SL/TP 管理器 (即使原生 STOP 已挂, 也保留, 以便统计与回放)
          managed.push({
            symbol: d.symbol, name: d.name, shares: d.positionSizeShares,
            entryPrice: Number(buy.filledPrice) || d.entryPrice,
            stopLoss: d.stopLoss, takeProfit: d.takeProfit,
            openedAt: new Date().toISOString(), reason: d.reason,
          });
        } catch (e) {
          console.error(`  ❌ ${d.symbol} 失败: ${(e as Error).message}`);
        }
      }
      saveManaged(managedPath, managed);
      console.log(`\n所有订单已提交.`);

      appendCycleLog(jsonlPath, {
        ts: new Date().toISOString(), env, account,
        positions: positions.map((p) => ({ symbol: p.symbol, qty: p.qty, costPrice: p.costPrice, currentPrice: p.currentPrice, plRatio: p.plRatio })),
        signals: result.signals.length, newsCount: result.news.length, strongCount: result.assessments.filter(a=>a.strength==='strong').length,
        riskGate: result.riskGateReason ?? null,
        decisions: result.decisions.map((d) => ({ symbol: d.symbol, name: d.name, shares: d.positionSizeShares, entry: d.entryPrice, sl: d.stopLoss, tp: d.takeProfit, reason: d.reason })),
        executions, managedExits, managedOpen: managed.length,
      });
      writeDailySummary({ mdPath, today, account, positions, managed, jsonlPath });

      if (!watch) break;
      await sleep(intervalMs);
    }
  } finally {
    await bridge.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
