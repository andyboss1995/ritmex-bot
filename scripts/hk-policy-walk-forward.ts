import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BacktestEngineEntity,
  type BacktestResult,
  type DecisionContext,
  type DecisionExecutor,
  type HistoricalSeries,
  type HkMomentumPolicyConfig,
  type MomentumSignal,
  type NewsItem,
  type PolicyAssessment,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";

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
    const out: TradeDecision[] = [];
    const sc = new Map(ctx.openSectorCounts ?? new Map<string, number>());
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
      if (this.mode !== "off" && (symbolCat.get(sig.symbol) ?? []).length === 0) continue;
      if (!applySectorCap(sig, sc, ctx)) continue;
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
        reason: this.mode, catalysts: [], signal: sig,
      });
    }
    return out;
  }
}

interface KlineFile { series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>; }
interface NewsFile { byDate: Record<string, NewsItem[]>; bySymbol: Record<string, NewsItem[]>; }

function trimToWindow(series: HistoricalSeries[], from: string, to: string, warmup = 50): HistoricalSeries[] {
  return series.map((s) => {
    const fromIdx = s.bars.findIndex((b) => b.date >= from);
    const toIdx = s.bars.findIndex((b) => b.date > to);
    const start = Math.max(0, (fromIdx < 0 ? 0 : fromIdx) - warmup);
    const end = toIdx < 0 ? s.bars.length : toIdx;
    return { ...s, bars: s.bars.slice(start, end) };
  });
}

function trimNews(news: Record<string, NewsItem[]>, from: string, to: string): Record<string, NewsItem[]> {
  const out: Record<string, NewsItem[]> = {};
  for (const [d, items] of Object.entries(news)) {
    if (d >= from && d <= to) out[d] = items;
  }
  return out;
}

async function backtest(series: HistoricalSeries[], news: Record<string, NewsItem[]>, sectors: Map<string, string[]>, cfg: Partial<HkMomentumPolicyConfig>, mode: "off" | "medium" | "strong"): Promise<BacktestResult> {
  const opts = {
    series, newsByDate: mode === "off" ? {} : news, initialEquityHkd: 1_000_000,
    decisionExecutor: new CatalystExecutor(mode), config: cfg, symbolSectors: sectors,
  };
  return await new BacktestEngineEntity(opts).run(opts);
}

async function main(): Promise<void> {
  const raw: KlineFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_universe_kline.json"), "utf8"));
  const series: HistoricalSeries[] = raw.series.map((s) => ({
    symbol: s.symbol, name: s.name,
    bars: s.bars.map((b) => ({ date: String(b.date), open: Number(b.open), high: Number(b.high), low: Number(b.low), close: Number(b.close), volume: Number(b.volume), turnover: Number(b.turnover) })),
  }));
  const news: NewsFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
  const sectors = new Map<string, string[]>();
  for (const [sym, items] of Object.entries(news.bySymbol)) {
    const set = new Set<string>();
    for (const it of items) for (const sec of it.sectors ?? []) set.add(sec);
    if (set.size > 0) sectors.set(sym, Array.from(set));
  }

  const newsDates = Object.keys(news.byDate).sort();
  const fullStart = newsDates[0]!;
  const fullEnd = newsDates.at(-1)!;
  // 拆分: IS 前 70%, OOS 后 30%
  const splitIdx = Math.floor(newsDates.length * 0.7);
  const isEnd = newsDates[splitIdx - 1]!;
  const oosStart = newsDates[splitIdx]!;

  console.log(`数据全段: ${fullStart} → ${fullEnd} (${newsDates.length} 个有新闻的交易日)`);
  console.log(`In-Sample (IS):    ${fullStart} → ${isEnd}`);
  console.log(`Out-of-Sample(OOS): ${oosStart} → ${fullEnd}\n`);

  // 用 grid 找出的两套候选
  const candidates: Array<{ name: string; cfg: Partial<HkMomentumPolicyConfig>; mode: "off"|"medium"|"strong" }> = [
    { name: "保守 (mp5 risk1.0% ATR1.0 strong)", mode: "strong",
      cfg: { maxPositions: 5, perTradeRiskPct: 0.01, stopLossMode: "atr", atrStopMultiplier: 1.0, atrTakeProfitMultiplier: 2.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open", intradayDrawdownHaltPct: 0.15, maxPositionsPerSector: 2 } },
    { name: "激进 (mp5 risk1.5% ATR2.0 medium)", mode: "medium",
      cfg: { maxPositions: 5, perTradeRiskPct: 0.015, stopLossMode: "atr", atrStopMultiplier: 2.0, atrTakeProfitMultiplier: 4.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open", intradayDrawdownHaltPct: 0.15, maxPositionsPerSector: 2 } },
    { name: "Tech-only baseline (mp5 risk1.0% ATR1.0)", mode: "off",
      cfg: { maxPositions: 5, perTradeRiskPct: 0.01, stopLossMode: "atr", atrStopMultiplier: 1.0, atrTakeProfitMultiplier: 2.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open", intradayDrawdownHaltPct: 0.15, maxPositionsPerSector: 2 } },
  ];

  for (const c of candidates) {
    console.log(`\n## ${c.name}`);
    const isSeries = trimToWindow(series, fullStart, isEnd);
    const oosSeries = trimToWindow(series, oosStart, fullEnd);
    const isNews = trimNews(news.byDate, fullStart, isEnd);
    const oosNews = trimNews(news.byDate, oosStart, fullEnd);
    const isR = await backtest(isSeries, isNews, sectors, c.cfg, c.mode);
    const oosR = await backtest(oosSeries, oosNews, sectors, c.cfg, c.mode);
    print("IS ", isR);
    print("OOS", oosR);
    const degrade = oosR.totalReturnPct - isR.totalReturnPct;
    const shrpDegrade = oosR.sharpeDaily - isR.sharpeDaily;
    console.log(`  退化: ret Δ=${(degrade*100).toFixed(2)}%, Sharpe Δ=${shrpDegrade.toFixed(2)}`);
  }
}

function print(tag: string, r: BacktestResult): void {
  const reasons: Record<string, number> = {};
  for (const t of r.trades) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
  const payoff = Number.isFinite(r.payoffRatio) ? r.payoffRatio.toFixed(2) : "Inf";
  console.log(`  [${tag}] tr=${r.trades.length} ret=${(r.totalReturnPct*100).toFixed(2)}% wr=${(r.winRate*100).toFixed(1)}% payoff=${payoff} maxDD=${(r.maxDrawdownPct*100).toFixed(2)}% Sharpe=${r.sharpeDaily.toFixed(2)} exp=${(r.expectancyPerTrade*100).toFixed(2)}% exits=${JSON.stringify(reasons)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
