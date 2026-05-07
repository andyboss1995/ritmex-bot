import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BacktestEngineEntity,
  type DecisionContext,
  type DecisionExecutor,
  type HistoricalSeries,
  type MomentumSignal,
  type PolicyAssessment,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";

class TechOnlyDecisionExecutor implements DecisionExecutor {
  async decide(signals: MomentumSignal[], _: PolicyAssessment[], ctx: DecisionContext): Promise<TradeDecision[]> {
    const slots = Math.max(0, ctx.config.maxPositions - ctx.openSymbols.length);
    if (slots <= 0) return [];
    const out: TradeDecision[] = [];
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (ctx.openSymbols.includes(sig.symbol)) continue;
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

interface KlineFile { start: string; end: string; series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>; }

async function main(): Promise<void> {
  const raw: KlineFile = JSON.parse(readFileSync(resolve(process.cwd(), "data/hk_universe_kline.json"), "utf8"));
  const series: HistoricalSeries[] = raw.series.map((s) => ({
    symbol: s.symbol, name: s.name,
    bars: s.bars.map((b) => ({
      date: String(b.date), open: Number(b.open), high: Number(b.high), low: Number(b.low),
      close: Number(b.close), volume: Number(b.volume), turnover: Number(b.turnover),
    })),
  }));

  const cfgs = [
    { label: "maxPos=3 ATR1.5", cfg: { maxPositions: 3, stopLossMode: "atr" as const, atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open" as const } },
    { label: "maxPos=10 ATR1.5", cfg: { maxPositions: 10, stopLossMode: "atr" as const, atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open" as const } },
    { label: "maxPos=20 ATR1.5", cfg: { maxPositions: 20, stopLossMode: "atr" as const, atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3.0, volumeMultiplier: 1.5, breakoutHighWindow: 20, breakoutSmaWindow: 20, minDailyTurnoverHkd: 50_000_000, entryTiming: "next_open" as const } },
  ];

  for (const c of cfgs) {
    const engine = new BacktestEngineEntity({ series, newsByDate: {}, initialEquityHkd: 1_000_000, decisionExecutor: new TechOnlyDecisionExecutor(), config: c.cfg });
    const r = await engine.run({ series, newsByDate: {}, initialEquityHkd: 1_000_000, decisionExecutor: new TechOnlyDecisionExecutor(), config: c.cfg });
    const reasons: Record<string, number> = {};
    for (const t of r.trades) reasons[t.exitReason] = (reasons[t.exitReason] ?? 0) + 1;
    console.log(`\n[${c.label}] trades=${r.trades.length} ret=${(r.totalReturnPct * 100).toFixed(2)}% wr=${(r.winRate * 100).toFixed(1)}% maxDD=${(r.maxDrawdownPct * 100).toFixed(2)}% Sharpe=${r.sharpeDaily.toFixed(2)}`);
    console.log(`  exit reasons: ${JSON.stringify(reasons)}`);
    if (r.trades.length <= 20) {
      for (const t of r.trades.slice(0, 20)) {
        console.log(`  ${t.symbol} ${t.openedAt}->${t.closedAt} ret=${(t.returnPct*100).toFixed(2)}% (${t.exitReason})`);
      }
    }
  }
}

main();
