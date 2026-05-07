import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BacktestEngineEntity,
  type BacktestResult,
  type DecisionContext,
  type DecisionExecutor,
  DefaultDecisionExecutor,
  type HistoricalSeries,
  type MomentumSignal,
  type NewsItem,
  type PolicyAssessment,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";

function applySectorCap(sig: MomentumSignal, sectorCounts: Map<string, number>, ctx: DecisionContext): boolean {
  const sectors = ctx.symbolSectors?.get(sig.symbol) ?? [];
  const cap = ctx.config.maxPositionsPerSector;
  if (cap > 0 && sectors.some((sec) => (sectorCounts.get(sec) ?? 0) >= cap)) return false;
  for (const sec of sectors) sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
  return true;
}

class TechOnlyDecisionExecutor implements DecisionExecutor {
  async decide(signals: MomentumSignal[], _: PolicyAssessment[], ctx: DecisionContext): Promise<TradeDecision[]> {
    const slots = Math.max(0, ctx.config.maxPositions - ctx.openSymbols.length);
    if (slots <= 0) return [];
    const sectorCounts = new Map(ctx.openSectorCounts ?? new Map<string, number>());
    const out: TradeDecision[] = [];
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
      if (!applySectorCap(sig, sectorCounts, ctx)) continue;
      const stop = sig.lastPrice * (1 - ctx.config.stopLossPct);
      const risk = sig.lastPrice - stop;
      if (risk <= 0) continue;
      const budget = Math.min(ctx.totalEquityHkd * ctx.config.perTradeRiskPct, ctx.riskBudgetHkd);
      const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
      if (shares <= 0) continue;
      out.push({
        symbol: sig.symbol, name: sig.name, action: "enter",
        entryPrice: sig.lastPrice, stopLoss: stop,
        takeProfit: sig.lastPrice * (1 + ctx.config.takeProfitPct),
        trailingMa: ctx.config.trailingMa,
        positionSizeShares: shares, positionSizeNotional: shares * sig.lastPrice,
        reason: "tech-only", catalysts: [], signal: sig,
      });
    }
    return out;
  }
}

class MediumOrStrongCatalystExecutor implements DecisionExecutor {
  async decide(signals: MomentumSignal[], assessments: PolicyAssessment[], ctx: DecisionContext): Promise<TradeDecision[]> {
    const slots = Math.max(0, ctx.config.maxPositions - ctx.openSymbols.length);
    if (slots <= 0) return [];
    const symbolCat = new Map<string, PolicyAssessment[]>();
    for (const a of assessments) {
      if (a.strength === "weak" || a.strength === "none") continue;
      for (const s of a.beneficiarySymbols) {
        if (!symbolCat.has(s)) symbolCat.set(s, []);
        symbolCat.get(s)!.push(a);
      }
    }
    const out: TradeDecision[] = [];
    const sectorCounts = new Map(ctx.openSectorCounts ?? new Map<string, number>());
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
      const cats = symbolCat.get(sig.symbol) ?? [];
      if (cats.length === 0) continue;
      if (!applySectorCap(sig, sectorCounts, ctx)) continue;
      const stop = sig.lastPrice * (1 - ctx.config.stopLossPct);
      const risk = sig.lastPrice - stop;
      if (risk <= 0) continue;
      const budget = Math.min(ctx.totalEquityHkd * ctx.config.perTradeRiskPct, ctx.riskBudgetHkd);
      const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
      if (shares <= 0) continue;
      out.push({
        symbol: sig.symbol, name: sig.name, action: "enter",
        entryPrice: sig.lastPrice, stopLoss: stop,
        takeProfit: sig.lastPrice * (1 + ctx.config.takeProfitPct),
        trailingMa: ctx.config.trailingMa,
        positionSizeShares: shares, positionSizeNotional: shares * sig.lastPrice,
        reason: `催化(中/强): ${cats.map((c) => c.reasoning).join("|")}`, catalysts: cats, signal: sig,
      });
    }
    return out;
  }
}

interface KlineFile { start: string; end: string; series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>; }
interface NewsFile { byDate: Record<string, NewsItem[]>; bySymbol: Record<string, NewsItem[]>; }

function loadSeries(p: string): HistoricalSeries[] {
  const raw: KlineFile = JSON.parse(readFileSync(p, "utf8"));
  return raw.series.map((s) => ({
    symbol: s.symbol, name: s.name,
    bars: s.bars.map((b) => ({
      date: String(b.date), open: Number(b.open), high: Number(b.high), low: Number(b.low),
      close: Number(b.close), volume: Number(b.volume), turnover: Number(b.turnover),
    })),
  }));
}

function trimSeries(series: HistoricalSeries[], fromDate: string): HistoricalSeries[] {
  return series.map((s) => {
    const idx = s.bars.findIndex((b) => b.date >= fromDate);
    if (idx < 0) return s;
    // 留 50 根 warmup 在 fromDate 之前
    const keepFrom = Math.max(0, idx - 50);
    return { ...s, bars: s.bars.slice(keepFrom) };
  });
}

async function main(): Promise<void> {
  const series = loadSeries(resolve(process.cwd(), "data/hk_universe_kline.json"));
  const news: NewsFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
  const newsByDate = news.byDate;
  const newsDates = Object.keys(newsByDate).sort();
  const newsCount = Object.values(newsByDate).reduce((a, v) => a + v.length, 0);
  console.log(`数据: 价格=${series.length} 标的, 新闻=${newsCount} 条 (${newsDates[0]} → ${newsDates.at(-1)})`);

  // 信号区间收紧到新闻覆盖窗口
  const fromDate = newsDates[0]!;
  const trimmed = trimSeries(series, fromDate);

  const baseCfg = {
    maxPositions: 10,
    stopLossMode: "atr" as const,
    atrStopMultiplier: 1.5,
    atrTakeProfitMultiplier: 3.0,
    volumeMultiplier: 1.5,
    breakoutHighWindow: 20,
    breakoutSmaWindow: 20,
    minDailyTurnoverHkd: 50_000_000,
    entryTiming: "next_open" as const,
  };
  const initial = 1_000_000;

  // 构建 symbolSectors 映射: 每只股的板块 = 它历史新闻里所有 sectors 的并集
  const symbolSectors = new Map<string, string[]>();
  for (const [sym, items] of Object.entries(news.bySymbol)) {
    const secSet = new Set<string>();
    for (const it of items) for (const s of it.sectors ?? []) secSet.add(s);
    if (secSet.size > 0) symbolSectors.set(sym, Array.from(secSet));
  }
  console.log(`板块映射: ${symbolSectors.size} 只股有板块标签`);

  const cases = [
    { label: "tech-only (无催化过滤)", exec: () => new TechOnlyDecisionExecutor(), nbd: {} as Record<string, NewsItem[]> },
    { label: "medium+strong 催化过滤", exec: () => new MediumOrStrongCatalystExecutor(), nbd: newsByDate },
    { label: "仅 strong 催化过滤 (Default)", exec: () => new DefaultDecisionExecutor(), nbd: newsByDate },
  ];

  for (const c of cases) {
    const engine = new BacktestEngineEntity({
      series: trimmed, newsByDate: c.nbd, initialEquityHkd: initial,
      decisionExecutor: c.exec(), config: baseCfg, symbolSectors,
    });
    const r = await engine.run({
      series: trimmed, newsByDate: c.nbd, initialEquityHkd: initial,
      decisionExecutor: c.exec(), config: baseCfg, symbolSectors,
    });
    print(c.label, r);
  }
}

function print(label: string, r: BacktestResult): void {
  const reasons: Record<string, number> = {};
  for (const t of r.trades) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
  console.log(`\n## ${label}`);
  console.log(`  trades=${r.trades.length} | ret=${(r.totalReturnPct * 100).toFixed(2)}% | wr=${(r.winRate * 100).toFixed(1)}% | payoff=${Number.isFinite(r.payoffRatio) ? r.payoffRatio.toFixed(2) : "Inf"} | maxDD=${(r.maxDrawdownPct * 100).toFixed(2)}% | Sharpe=${r.sharpeDaily.toFixed(2)} | exp/trade=${(r.expectancyPerTrade * 100).toFixed(2)}%`);
  console.log(`  exits: ${JSON.stringify(reasons)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
