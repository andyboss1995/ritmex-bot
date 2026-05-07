import type {
  AccountStateEntity,
  MomentumSignal,
  NewsItem,
  PolicyAssessment,
  PositionEntity,
  TradeDecision,
} from "./types";

export interface DailyReportInput {
  reportDate: string;
  hsiClose: number;
  hsiChangePct: number;
  southboundNetHkd: number;
  news: NewsItem[];
  assessments: PolicyAssessment[];
  signals: MomentumSignal[];
  decisions: TradeDecision[];
  positions: PositionEntity[];
  closedToday: Array<{ symbol: string; name: string; pnlPct: number; pnlHkd: number; reason: string }>;
  account: AccountStateEntity;
  weeklyPnlHkd: number;
  monthlyPnlHkd: number;
  riskGateReason?: string;
}

export function buildDailyReport(input: DailyReportInput): string {
  const lines: string[] = [];
  lines.push("# 量价突破 + 政策催化策略执行报告");
  lines.push(`日期: ${input.reportDate}`);
  lines.push("");
  lines.push("## 1. 今日市场总结");
  lines.push(
    `HSI 收 ${input.hsiClose.toFixed(2)} 点 (${(input.hsiChangePct * 100).toFixed(2)}%), 南向资金净流入 ${(
      input.southboundNetHkd / 1e8
    ).toFixed(2)} 亿港币`
  );
  lines.push("");
  lines.push("## 2. 3 智能体政策催化分析");
  lines.push("### Agent 1 · News Grabber");
  if (!input.news.length) lines.push("- 无 24-48h 高影响力新闻");
  for (const n of input.news) {
    lines.push(`- [${n.publishedAt}] ${n.title} — ${n.source}`);
    if (n.summary) lines.push(`  摘要: ${n.summary}`);
  }
  lines.push("");
  lines.push("### Agent 2 · Policy Analyst");
  if (!input.assessments.length) lines.push("- 无政策评估");
  for (const a of input.assessments) {
    lines.push(
      `- [${a.strength.toUpperCase()}] news=${a.newsId} 板块=${a.beneficiarySectors.join(",") || "-"} 标的=${a.beneficiarySymbols.join(",") || "-"}`
    );
    lines.push(`  逻辑: ${a.reasoning}`);
  }
  lines.push("");
  lines.push("### Agent 3 · Decision Executor");
  if (!input.decisions.length) lines.push("- 无新入场信号 (量价 ∧ 强催化未同时满足或风控关闭)");
  for (const d of input.decisions) {
    lines.push(
      `- ${d.symbol} ${d.name} 入场=${d.entryPrice} 止损=${d.stopLoss} 止盈=${d.takeProfit} 仓位=${d.positionSizeShares}股 (${d.positionSizeNotional.toFixed(0)} HKD)`
    );
    lines.push(`  理由: ${d.reason}`);
  }
  if (input.riskGateReason) lines.push(`- 风控关闭新仓: ${input.riskGateReason}`);
  lines.push("");
  lines.push("## 3. 持仓与今日平仓");
  if (!input.positions.length) lines.push("- 当前无持仓");
  for (const p of input.positions) {
    lines.push(
      `- 持: ${p.symbol} ${p.name} 入场=${p.entryPrice} 止损=${p.stopLoss} 止盈=${p.takeProfit} 持股=${p.shares} 部分止盈=${p.partialTaken ? "是" : "否"}`
    );
  }
  for (const c of input.closedToday) {
    lines.push(
      `- 平: ${c.symbol} ${c.name} 收益=${(c.pnlPct * 100).toFixed(2)}% (${c.pnlHkd.toFixed(0)} HKD) 原因=${c.reason}`
    );
  }
  lines.push("");
  lines.push("## 4. 今日扫描的量价候选");
  if (!input.signals.length) lines.push("- 无候选");
  for (const s of input.signals.slice(0, 10)) {
    lines.push(
      `- ${s.symbol} ${s.name} 现价=${s.lastPrice} 量比=${s.volumeRatio.toFixed(2)} 突破=${s.breakoutType} RSI=${s.rsi.toFixed(1)} MACD柱=${s.macdHist.toFixed(3)}`
    );
  }
  lines.push("");
  lines.push("## 5. 风险提示与仓位调整");
  const dd = input.account.peakEquityHkd > 0
    ? (input.account.peakEquityHkd - input.account.totalEquityHkd) / input.account.peakEquityHkd
    : 0;
  lines.push(
    `- 总权益 ${input.account.totalEquityHkd.toFixed(0)} HKD, 当日已实现 ${input.account.realizedPnlToday.toFixed(0)} HKD, 当前回撤 ${(dd * 100).toFixed(2)}%`
  );
  if (input.account.haltedUntil) lines.push(`- 回撤熔断至 ${input.account.haltedUntil}`);
  if (input.account.pausedUntil) lines.push(`- 连亏暂停至 ${input.account.pausedUntil}`);
  lines.push("");
  lines.push("## 6. 累计收益统计");
  lines.push(
    `- 本周 ${input.weeklyPnlHkd.toFixed(0)} HKD, 本月 ${input.monthlyPnlHkd.toFixed(0)} HKD, 历史净已实现 ${input.account.realizedPnlHistory
      .reduce((a, b) => a + b, 0)
      .toFixed(0)} HKD`
  );
  return lines.join("\n");
}
