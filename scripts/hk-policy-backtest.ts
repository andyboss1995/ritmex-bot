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
  type PolicyAssessment,
  type TradeDecision,
} from "../src/strategy/hk-momentum-policy";

class TechOnlyDecisionExecutor implements DecisionExecutor {
  async decide(
    signals: MomentumSignal[],
    _assessments: PolicyAssessment[],
    context: DecisionContext
  ): Promise<TradeDecision[]> {
    const decisions: TradeDecision[] = [];
    const slotsLeft = Math.max(0, context.config.maxPositions - context.openSymbols.length);
    if (slotsLeft <= 0) return decisions;
    const ranked = signals.filter((s) => !context.openSymbols.includes(s.symbol));
    for (const sig of ranked) {
      if (decisions.length >= slotsLeft) break;
      const stopLoss = round3(sig.lastPrice * (1 - context.config.stopLossPct));
      const riskPerShare = sig.lastPrice - stopLoss;
      if (riskPerShare <= 0) continue;
      const riskBudget = Math.min(
        context.totalEquityHkd * context.config.perTradeRiskPct,
        context.riskBudgetHkd
      );
      if (riskBudget <= 0) continue;
      const shares = Math.max(0, Math.floor(riskBudget / riskPerShare / 100) * 100);
      if (shares <= 0) continue;
      decisions.push({
        symbol: sig.symbol,
        name: sig.name,
        action: "enter",
        entryPrice: sig.lastPrice,
        stopLoss,
        takeProfit: round3(sig.lastPrice * (1 + context.config.takeProfitPct)),
        trailingMa: context.config.trailingMa,
        positionSizeShares: shares,
        positionSizeNotional: shares * sig.lastPrice,
        reason: `tech-only: 量比${sig.volumeRatio.toFixed(2)} ${sig.breakoutType} RSI${sig.rsi.toFixed(1)} MACD柱${sig.macdHist.toFixed(3)}`,
        catalysts: [],
        signal: sig,
      });
    }
    return decisions;
  }
}

function round3(p: number): number {
  return Math.round(p * 1000) / 1000;
}

interface KlineFile {
  start: string;
  end: string;
  series: Array<{ symbol: string; name: string; bars: Array<Record<string, number | string>> }>;
}

async function main(): Promise<void> {
  const path = resolve(process.cwd(), process.argv[2] ?? "data/hk_kline.json");
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

  const initialEquity = 1_000_000;
  console.log(`# HK Momentum + Policy Catalyst — 真实回测 (Futu OpenD 数据)`);
  console.log(`数据: ${raw.start} → ${raw.end}, ${series.length} 标的, ${series.reduce((a, s) => a + s.bars.length, 0)} 根日 K`);
  console.log(`初始资金: ${initialEquity.toLocaleString()} HKD\n`);

  // 1) 纯技术（无政策催化过滤），衡量量价突破组合自身的边际
  const techEngine = new BacktestEngineEntity({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new TechOnlyDecisionExecutor(),
  });
  const techResult = await techEngine.run({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new TechOnlyDecisionExecutor(),
  });
  printResult("【基准 1】纯量价突破（无政策过滤）", techResult, initialEquity);

  // 2) 含催化（KeywordPolicyAnalyst + DefaultDecisionExecutor），但当前没真新闻数据，所以注定 0 笔
  // 这里是占位/对照；真实跑需要 newsByDate
  const catalystEngine = new BacktestEngineEntity({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new DefaultDecisionExecutor(),
  });
  const catalystResult = await catalystEngine.run({
    series,
    newsByDate: {},
    initialEquityHkd: initialEquity,
    decisionExecutor: new DefaultDecisionExecutor(),
  });
  printResult("【基准 2】含政策催化过滤（无新闻数据 → 应为 0 笔）", catalystResult, initialEquity);
}

function printResult(label: string, r: BacktestResult, initialEquity: number): void {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const wins = r.trades.filter((t) => t.pnlHkd > 0).length;
  const losses = r.trades.length - wins;
  const stops = r.trades.filter((t) => t.exitReason === "stop").length;
  const tps = r.trades.filter((t) => t.exitReason === "takeProfit").length;
  const trails = r.trades.filter((t) => t.exitReason === "trailing").length;
  console.log(`## ${label}`);
  console.log(`总交易: ${r.trades.length} (赢 ${wins} / 输 ${losses}) | 止损 ${stops} / 止盈 ${tps} / 跟踪 ${trails}`);
  console.log(`总回报: ${pct(r.totalReturnPct)} | CAGR ≈ ${pct(r.cagrAnnualized)} | 最大回撤 ${pct(r.maxDrawdownPct)} | 日 Sharpe ${r.sharpeDaily.toFixed(2)}`);
  console.log(`胜率 ${pct(r.winRate)} | 盈亏比 ${Number.isFinite(r.payoffRatio) ? r.payoffRatio.toFixed(2) : "Inf"} | 单笔期望 ${pct(r.expectancyPerTrade)}`);
  console.log(`期末权益 ${r.finalEquityHkd.toLocaleString(undefined, { maximumFractionDigits: 0 })} HKD (从 ${initialEquity.toLocaleString()})`);
  if (r.trades.length > 0) {
    const top5 = [...r.trades].sort((a, b) => b.pnlHkd - a.pnlHkd).slice(0, 5);
    const bot5 = [...r.trades].sort((a, b) => a.pnlHkd - b.pnlHkd).slice(0, 5);
    console.log(`Top 5 winners:`);
    for (const t of top5) console.log(`  ${t.symbol} ${t.openedAt}→${t.closedAt} ${pct(t.returnPct)} (${t.exitReason})`);
    console.log(`Top 5 losers:`);
    for (const t of bot5) console.log(`  ${t.symbol} ${t.openedAt}→${t.closedAt} ${pct(t.returnPct)} (${t.exitReason})`);
  }
  console.log("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
