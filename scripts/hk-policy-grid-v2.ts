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

function applySectorCap(sig: MomentumSignal, sectorCounts: Map<string, number>, ctx: DecisionContext): boolean {
  const sectors = ctx.symbolSectors?.get(sig.symbol) ?? [];
  const cap = ctx.config.maxPositionsPerSector;
  if (cap > 0 && sectors.some((sec) => (sectorCounts.get(sec) ?? 0) >= cap)) return false;
  for (const sec of sectors) sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
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
    const sectorCounts = new Map(ctx.openSectorCounts ?? new Map<string, number>());
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
      if (this.mode !== "off") {
        const cats = symbolCat.get(sig.symbol) ?? [];
        if (cats.length === 0) continue;
      }
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
        reason: this.mode, catalysts: [], signal: sig,
      });
    }
    return out;
  }
}

interface KlineFile { start: string; end: string; series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>; }
interface NewsFile { byDate: Record<string, NewsItem[]>; bySymbol: Record<string, NewsItem[]>; }

function loadAll(): { series: HistoricalSeries[]; newsByDate: Record<string, NewsItem[]>; symbolSectors: Map<string, string[]>; fromDate: string } {
  const raw: KlineFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_universe_kline.json"), "utf8"));
  const series: HistoricalSeries[] = raw.series.map((s) => ({
    symbol: s.symbol, name: s.name,
    bars: s.bars.map((b) => ({
      date: String(b.date), open: Number(b.open), high: Number(b.high), low: Number(b.low),
      close: Number(b.close), volume: Number(b.volume), turnover: Number(b.turnover),
    })),
  }));
  const news: NewsFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_news.json"), "utf8"));
  const fromDate = Object.keys(news.byDate).sort()[0]!;
  const trimmed = series.map((s) => {
    const idx = s.bars.findIndex((b) => b.date >= fromDate);
    if (idx < 0) return s;
    return { ...s, bars: s.bars.slice(Math.max(0, idx - 50)) };
  });
  const symbolSectors = new Map<string, string[]>();
  for (const [sym, items] of Object.entries(news.bySymbol)) {
    const set = new Set<string>();
    for (const it of items) for (const sec of it.sectors ?? []) set.add(sec);
    if (set.size > 0) symbolSectors.set(sym, Array.from(set));
  }
  return { series: trimmed, newsByDate: news.byDate, symbolSectors, fromDate };
}

interface Cell { label: string; cfg: Partial<HkMomentumPolicyConfig>; mode: "off" | "medium" | "strong"; result: BacktestResult; }

async function runOne(label: string, cfg: Partial<HkMomentumPolicyConfig>, mode: "off" | "medium" | "strong",
                     series: HistoricalSeries[], newsByDate: Record<string, NewsItem[]>, symbolSectors: Map<string, string[]>): Promise<Cell> {
  const exec = new CatalystExecutor(mode);
  const opts = {
    series, newsByDate: mode === "off" ? {} : newsByDate, initialEquityHkd: 1_000_000,
    decisionExecutor: exec, config: cfg, symbolSectors,
  };
  const r = await new BacktestEngineEntity(opts).run(opts);
  return { label, cfg, mode, result: r };
}

async function main(): Promise<void> {
  const { series, newsByDate, symbolSectors, fromDate } = loadAll();
  console.log(`数据: ${series.length} 标的, 新闻起 ${fromDate}, 板块映射 ${symbolSectors.size}\n`);

  const grid: Cell[] = [];

  // 探索维度: maxPositions × perTradeRisk × ATR mult × catalyst mode
  const maxPositionsList = [3, 5, 7, 10];
  const perTradeRisks = [0.01, 0.015, 0.02, 0.025];
  const atrStops = [1.0, 1.5, 2.0];
  const modes: Array<"off" | "medium" | "strong"> = ["off", "medium", "strong"];

  let total = 0;
  for (const mp of maxPositionsList)
    for (const ptr of perTradeRisks)
      for (const atr of atrStops)
        for (const mode of modes) total++;

  let i = 0;
  for (const mp of maxPositionsList) {
    for (const ptr of perTradeRisks) {
      for (const atr of atrStops) {
        for (const mode of modes) {
          i++;
          const cfg: Partial<HkMomentumPolicyConfig> = {
            maxPositions: mp,
            perTradeRiskPct: ptr,
            stopLossMode: "atr",
            atrStopMultiplier: atr,
            atrTakeProfitMultiplier: atr * 2,
            volumeMultiplier: 1.5,
            breakoutHighWindow: 20,
            breakoutSmaWindow: 20,
            minDailyTurnoverHkd: 50_000_000,
            entryTiming: "next_open",
            intradayDrawdownHaltPct: 0.15,
            maxPositionsPerSector: 2,
          };
          const label = `mp${mp} risk${(ptr*100).toFixed(1)}% atr${atr} ${mode}`;
          process.stdout.write(`  [${i}/${total}] ${label} ... `);
          const cell = await runOne(label, cfg, mode, series, newsByDate, symbolSectors);
          grid.push(cell);
          const r = cell.result;
          console.log(`tr=${r.trades.length} ret=${(r.totalReturnPct*100).toFixed(1)}% wr=${(r.winRate*100).toFixed(0)}% maxDD=${(r.maxDrawdownPct*100).toFixed(1)}% Sh=${r.sharpeDaily.toFixed(2)}`);
        }
      }
    }
  }

  console.log(`\n## 过滤: maxDD ≤ 15.5% AND trades ≥ 8 AND ret > 0`);
  const eligible = grid.filter((c) => c.result.maxDrawdownPct <= 0.155 && c.result.trades.length >= 8 && c.result.totalReturnPct > 0);
  eligible.sort((a, b) => b.result.sharpeDaily - a.result.sharpeDaily);
  printTable(eligible.slice(0, 15));

  console.log(`\n## 全榜 Top 15 by Sharpe (允许任意条件)`);
  const all = [...grid].sort((a, b) => b.result.sharpeDaily - a.result.sharpeDaily);
  printTable(all.slice(0, 15));

  console.log(`\n## 全榜 Top 15 by total return`);
  const byRet = [...grid].sort((a, b) => b.result.totalReturnPct - a.result.totalReturnPct);
  printTable(byRet.slice(0, 15));
}

function printTable(rows: Cell[]): void {
  console.log("label                                  | tr  | ret    | win   | payoff | maxDD  | Sharpe | exp/trd");
  console.log("---------------------------------------|-----|--------|-------|--------|--------|--------|--------");
  for (const c of rows) {
    const r = c.result;
    const payoff = Number.isFinite(r.payoffRatio) ? r.payoffRatio.toFixed(2) : "Inf";
    console.log(
      `${c.label.padEnd(38)} | ${String(r.trades.length).padStart(3)} | ${(r.totalReturnPct*100).toFixed(2).padStart(6)}% | ${(r.winRate*100).toFixed(1).padStart(4)}% | ${payoff.padStart(6)} | ${(r.maxDrawdownPct*100).toFixed(2).padStart(5)}% | ${r.sharpeDaily.toFixed(2).padStart(6)} | ${(r.expectancyPerTrade*100).toFixed(2).padStart(5)}%`
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
