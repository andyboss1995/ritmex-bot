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
  type PolicyAssessment,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";

class TechOnlyDecisionExecutor implements DecisionExecutor {
  async decide(
    signals: MomentumSignal[],
    _: PolicyAssessment[],
    context: DecisionContext
  ): Promise<TradeDecision[]> {
    const out: TradeDecision[] = [];
    const slots = Math.max(0, context.config.maxPositions - context.openSymbols.length);
    if (slots <= 0) return out;
    for (const sig of signals) {
      if (out.length >= slots) break;
      if (context.openSymbols.includes(sig.symbol)) continue;
      const stop = sig.lastPrice * (1 - context.config.stopLossPct);
      const risk = sig.lastPrice - stop;
      if (risk <= 0) continue;
      const budget = Math.min(
        context.totalEquityHkd * context.config.perTradeRiskPct,
        context.riskBudgetHkd
      );
      const shares = Math.max(0, Math.floor(budget / risk / 100) * 100);
      if (shares <= 0) continue;
      out.push({
        symbol: sig.symbol,
        name: sig.name,
        action: "enter",
        entryPrice: sig.lastPrice,
        stopLoss: stop,
        takeProfit: sig.lastPrice * (1 + context.config.takeProfitPct),
        trailingMa: context.config.trailingMa,
        positionSizeShares: shares,
        positionSizeNotional: shares * sig.lastPrice,
        reason: "tech-only",
        catalysts: [],
        signal: sig,
      });
    }
    return out;
  }
}

interface KlineFile {
  start: string;
  end: string;
  series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>;
}

async function runOne(
  series: HistoricalSeries[],
  override: Partial<HkMomentumPolicyConfig>,
  initialEquity: number
): Promise<BacktestResult> {
  const engine = new BacktestEngineEntity({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new TechOnlyDecisionExecutor(),
    config: override,
  });
  return engine.run({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new TechOnlyDecisionExecutor(),
    config: override,
  });
}

async function main(): Promise<void> {
  const path = resolve(process.cwd(), process.argv[2] ?? "data/hk_universe_kline.json");
  const raw: KlineFile = JSON.parse(readFileSync(path, "utf8"));
  const series: HistoricalSeries[] = raw.series.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    bars: s.bars.map((b) => ({
      date: String(b.date),
      open: Number(b.open),
      high: Number(b.high),
      low: Number(b.low),
      close: Number(b.close),
      volume: Number(b.volume),
      turnover: Number(b.turnover),
    })),
  }));
  const initial = 1_000_000;
  const totalBars = series.reduce((a, s) => a + s.bars.length, 0);
  console.log(`# HK Momentum 参数 Grid Search (Futu OpenD 真实数据)`);
  console.log(`数据: ${raw.start} → ${raw.end}, 标的=${series.length}, 日线=${totalBars}`);
  console.log(`初始资金: ${initial.toLocaleString()} HKD\n`);

  const grid: Array<{ label: string; cfg: Partial<HkMomentumPolicyConfig> }> = [];

  // 1) 入场时机 × 止损模式 baseline grid
  const volMults = [1.3, 1.5, 1.8];
  const breakoutWins = [10, 20];
  const entryTimings: Array<"next_open" | "same_close"> = ["next_open", "same_close"];
  const stopVariants: Array<{ name: string; cfg: Partial<HkMomentumPolicyConfig> }> = [
    { name: "fixed1.8%", cfg: { stopLossMode: "fixed", stopLossPct: 0.018, takeProfitPct: 0.05 } },
    { name: "fixed3.0%", cfg: { stopLossMode: "fixed", stopLossPct: 0.030, takeProfitPct: 0.08 } },
    { name: "ATR1.0x", cfg: { stopLossMode: "atr", atrStopMultiplier: 1.0, atrTakeProfitMultiplier: 2.5 } },
    { name: "ATR1.5x", cfg: { stopLossMode: "atr", atrStopMultiplier: 1.5, atrTakeProfitMultiplier: 3.0 } },
    { name: "ATR2.0x", cfg: { stopLossMode: "atr", atrStopMultiplier: 2.0, atrTakeProfitMultiplier: 4.0 } },
  ];

  for (const vm of volMults) {
    for (const bw of breakoutWins) {
      for (const et of entryTimings) {
        for (const sv of stopVariants) {
          grid.push({
            label: `vol${vm} bw${bw} ${et} ${sv.name}`,
            cfg: {
              volumeMultiplier: vm,
              breakoutHighWindow: bw,
              breakoutSmaWindow: bw,
              entryTiming: et,
              minDailyTurnoverHkd: 50_000_000,
              ...sv.cfg,
            },
          });
        }
      }
    }
  }

  type Row = { label: string; result: BacktestResult; cfg: Partial<HkMomentumPolicyConfig> };
  const rows: Row[] = [];
  let i = 0;
  for (const g of grid) {
    i++;
    process.stdout.write(`  [${i}/${grid.length}] ${g.label} ... `);
    const r = await runOne(series, g.cfg, initial);
    rows.push({ label: g.label, result: r, cfg: g.cfg });
    console.log(`trades=${r.trades.length} ret=${(r.totalReturnPct * 100).toFixed(2)}% wr=${(r.winRate * 100).toFixed(1)}% maxDD=${(r.maxDrawdownPct * 100).toFixed(2)}%`);
  }

  rows.sort((a, b) => b.result.totalReturnPct - a.result.totalReturnPct);
  console.log(`\n## Top 10 by total return (≥ 20 trades 才保留)`);
  printTable(rows.filter((r) => r.result.trades.length >= 20).slice(0, 10));

  rows.sort((a, b) => b.result.expectancyPerTrade - a.result.expectancyPerTrade);
  console.log(`\n## Top 10 by expectancy per trade (≥ 20 trades)`);
  printTable(rows.filter((r) => r.result.trades.length >= 20).slice(0, 10));

  rows.sort((a, b) => b.result.sharpeDaily - a.result.sharpeDaily);
  console.log(`\n## Top 10 by daily Sharpe (≥ 20 trades)`);
  printTable(rows.filter((r) => r.result.trades.length >= 20).slice(0, 10));

  console.log(`\n## Bottom 5 (worst total return)`);
  rows.sort((a, b) => a.result.totalReturnPct - b.result.totalReturnPct);
  printTable(rows.slice(0, 5));
}

function printTable(rows: Array<{ label: string; result: BacktestResult }>): void {
  console.log("label                                          | trades | return | win%  | payoff | maxDD  | Sharpe | exp/trade");
  console.log("-----------------------------------------------|--------|--------|-------|--------|--------|--------|----------");
  for (const { label, result: r } of rows) {
    const exp = `${(r.expectancyPerTrade * 100).toFixed(2)}%`;
    const payoff = Number.isFinite(r.payoffRatio) ? r.payoffRatio.toFixed(2) : "Inf";
    console.log(
      `${label.padEnd(46)} | ${String(r.trades.length).padStart(6)} | ${(r.totalReturnPct * 100).toFixed(2).padStart(6)}% | ${(r.winRate * 100).toFixed(1).padStart(5)}% | ${payoff.padStart(6)} | ${(r.maxDrawdownPct * 100).toFixed(2).padStart(5)}% | ${r.sharpeDaily.toFixed(2).padStart(6)} | ${exp.padStart(8)}`
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
