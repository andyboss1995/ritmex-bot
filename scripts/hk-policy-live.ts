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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  AkshareNewsGrabber,
  type DecisionContext,
  type DecisionExecutor,
  FutuTradeBridge,
  HkMomentumPolicyEngineEntity,
  type HkMomentumPolicyConfig,
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
    const account = await bridge.getAccount();
    console.log(`\n账户: 总资产=${account.totalAssets.toFixed(0)} ${account.currency} | 现金=${account.cash.toFixed(0)} | 持仓市值=${account.marketVal.toFixed(0)}`);
    const positions = await bridge.getPositions();
    console.log(`当前持仓: ${positions.length} 只`);
    for (const p of positions) {
      console.log(`  ${p.symbol} ${p.name}: ${p.qty} 股 @ 成本 ${p.costPrice.toFixed(3)} 现价 ${p.currentPrice.toFixed(3)} (P&L ${p.plRatio.toFixed(2)}%)`);
    }

    // 加载 universe + 快照
    const snapData: SnapshotFile = JSON.parse(readFileSync(snapPath, "utf8"));
    console.log(`\nuniverse 快照: ${snapData.snapshots.length} 只 (fetchedAt=${snapData.fetchedAt})`);

    // 板块映射
    const histNews = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
    const symbolSectors = new Map<string, string[]>();
    for (const [sym, items] of Object.entries(histNews.bySymbol as Record<string, NewsItem[]>)) {
      const set = new Set<string>();
      for (const it of items) for (const sec of it.sectors ?? []) set.add(sec);
      if (set.size > 0) symbolSectors.set(sym, Array.from(set));
    }

    // 保守组配置
    const cfg: Partial<HkMomentumPolicyConfig> = {
      maxPositions: 5, perTradeRiskPct: 0.01, stopLossMode: "atr",
      atrStopMultiplier: 1.0, atrTakeProfitMultiplier: 2.0,
      volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20,
      minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open",
      intradayDrawdownHaltPct: 0.15, maxPositionsPerSector: 2, drawdownHaltPct: 0.08,
    };

    const engine = new HkMomentumPolicyEngineEntity({
      marketData: new FileSnapshotSource(snapData.snapshots),
      newsGrabber: new AkshareNewsGrabber({ cachePath: newsCache, refreshScript, maxStaleMinutes: 15 }),
      decisionExecutor: new CatalystExecutor("strong"),
      symbolSectors, config: cfg,
    });

    const result = await engine.run({
      universe: snapData.snapshots.map((s) => s.symbol),
      account: {
        totalEquityHkd: account.totalAssets,
        realizedPnlToday: 0,
        realizedPnlHistory: [],
        peakEquityHkd: account.totalAssets,
      },
      positions: positions.map((p) => ({
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
      console.log(`  无入场建议. 退出.`);
      return;
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
        return;
      }
      console.log(`\n[AUTO] SIMULATE 模式自动提交 ${result.decisions.length} 笔订单`);
      ok = true;
    } else {
      ok = await confirm(`\n确认提交以上 ${result.decisions.length} 笔订单? (yes/N): `);
    }
    if (!ok) {
      console.log("已取消, 不下单.");
      return;
    }

    console.log(`\n## 开始下单 (${env})`);
    for (const d of result.decisions) {
      try {
        const buy = await bridge.submitMarketBuy(d.symbol, d.positionSizeShares);
        console.log(`  ✅ BUY  ${d.symbol} ${d.positionSizeShares} → orderId=${buy.orderId} fill=${buy.filledPrice}`);
        const stop = await bridge.submitStopLoss(d.symbol, d.positionSizeShares, d.stopLoss);
        console.log(`  ✅ STOP ${d.symbol} @ ${d.stopLoss.toFixed(3)} → orderId=${stop.orderId}`);
      } catch (e) {
        console.error(`  ❌ ${d.symbol} 失败: ${(e as Error).message}`);
      }
    }
    console.log(`\n所有订单已提交. 请在富途客户端中确认.`);
  } finally {
    await bridge.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
