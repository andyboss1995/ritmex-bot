/**
 * 实盘 dry-run: 拉真实市场快照 + 实时新闻 → 跑保守组参数 → 打印今日推荐决策.
 * 不下单, 不交互, 适合每天开盘前/盘中查看.
 *
 * 用法 (确保 OpenD 在跑):
 *   1. python3 scripts/futu_pull_snapshot.py        # 拉当下市场快照
 *   2. python3 scripts/akshare_pull_news_realtime.py # 拉近 24h 新闻 (或交给 NewsGrabber 自动刷新)
 *   3. bun run scripts/hk-policy-dry-run.ts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  AkshareNewsGrabber,
  type DecisionContext,
  type DecisionExecutor,
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

interface SnapshotFile {
  fetchedAt: string;
  marketState?: string;
  snapshots: Array<SymbolSnapshot & { lastPrice: number; preClose: number; intradayVolume: number }>;
}

class FileSnapshotSource implements MarketDataSource {
  constructor(private readonly snapshots: SymbolSnapshot[]) {}
  async loadSnapshots(symbols: string[]): Promise<SymbolSnapshot[]> {
    const set = new Set(symbols);
    return this.snapshots.filter((s) => set.has(s.symbol));
  }
  async loadNews(): Promise<NewsItem[]> {
    return [];
  }
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
        entryPrice: sig.lastPrice, stopLoss,
        takeProfit,
        trailingMa: ctx.config.trailingMa,
        positionSizeShares: shares, positionSizeNotional: shares * sig.lastPrice,
        reason: `${this.mode}; 量比${sig.volumeRatio.toFixed(2)} ${sig.breakoutType} RSI${sig.rsi.toFixed(1)}`,
        catalysts: cats, signal: sig,
      });
    }
    return out;
  }
}

async function main(): Promise<void> {
  const equity = Number(process.env.PAPER_EQUITY_HKD ?? 1_000_000);
  const snapPath = resolve(process.cwd(), "data/hk_snapshot.json");
  const newsCache = resolve(process.cwd(), "data/hk_news_live.json");
  const refreshScript = resolve(process.cwd(), "scripts/akshare_pull_news_realtime.py");

  const snapData: SnapshotFile = JSON.parse(readFileSync(snapPath, "utf8"));
  console.log(`快照时间: ${snapData.fetchedAt} | 港股市场状态: ${snapData.marketState ?? "?"}`);
  console.log(`universe 大小: ${snapData.snapshots.length}`);

  // 加载历史新闻 → 板块映射 (用于 sector cap)
  const histNews = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
  const symbolSectors = new Map<string, string[]>();
  for (const [sym, items] of Object.entries(histNews.bySymbol as Record<string, NewsItem[]>)) {
    const set = new Set<string>();
    for (const it of items) for (const sec of it.sectors ?? []) set.add(sec);
    if (set.size > 0) symbolSectors.set(sym, Array.from(set));
  }
  console.log(`板块映射: ${symbolSectors.size} 只股有板块标签`);

  // 保守组参数 (Walk-forward 验证后的推荐)
  const cfg: Partial<HkMomentumPolicyConfig> = {
    maxPositions: 5,
    perTradeRiskPct: 0.01,
    stopLossMode: "atr",
    atrStopMultiplier: 1.0,
    atrTakeProfitMultiplier: 2.0,
    volumeMultiplier: 1.5,
    breakoutHighWindow: 20,
    breakoutSmaWindow: 20,
    minDailyTurnoverHkd: 50_000_000,
    entryTiming: "next_open",
    intradayDrawdownHaltPct: 0.15,
    maxPositionsPerSector: 2,
    drawdownHaltPct: 0.08,
  };

  const engine = new HkMomentumPolicyEngineEntity({
    marketData: new FileSnapshotSource(snapData.snapshots),
    newsGrabber: new AkshareNewsGrabber({
      cachePath: newsCache,
      refreshScript,
      maxStaleMinutes: 15,
    }),
    decisionExecutor: new CatalystExecutor("strong"),
    symbolSectors,
    config: cfg,
  });

  const result = await engine.run({
    universe: snapData.snapshots.map((s) => s.symbol),
    account: {
      totalEquityHkd: equity,
      realizedPnlToday: 0,
      realizedPnlHistory: [],
      peakEquityHkd: equity,
    },
    positions: [],
    lookbackHours: 36,
  });

  console.log(`\n## 信号扫描`);
  console.log(`  共 ${result.signals.length} 个标的命中量价突破信号`);
  console.log(`  新闻: ${result.news.length} 条匹配 universe`);
  const strongCount = result.assessments.filter((a) => a.strength === "strong").length;
  const mediumCount = result.assessments.filter((a) => a.strength === "medium").length;
  console.log(`  催化评估: ${strongCount} strong, ${mediumCount} medium`);

  console.log(`\n## 今日推荐决策 (${result.decisions.length} 笔)`);
  if (result.riskGateReason) {
    console.log(`  ⚠️ 风控拦截: ${result.riskGateReason}`);
  }
  if (result.decisions.length === 0) {
    console.log(`  无满足条件的入场机会`);
  }
  for (const d of result.decisions) {
    console.log(`\n  📈 ${d.symbol} ${d.name}`);
    console.log(`     入场: ${d.entryPrice.toFixed(3)} HKD × ${d.positionSizeShares} 股 = ${d.positionSizeNotional.toFixed(0)} HKD`);
    console.log(`     止损: ${d.stopLoss.toFixed(3)} (${(((d.stopLoss - d.entryPrice) / d.entryPrice) * 100).toFixed(2)}%)`);
    console.log(`     止盈: ${d.takeProfit.toFixed(3)} (+${(((d.takeProfit - d.entryPrice) / d.entryPrice) * 100).toFixed(2)}%)`);
    console.log(`     理由: ${d.reason}`);
    if (d.catalysts.length > 0) {
      console.log(`     催化: ${d.catalysts.slice(0, 2).map((c) => c.reasoning).join(" | ")}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
