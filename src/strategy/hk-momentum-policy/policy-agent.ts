import type { HkMomentumPolicyConfig } from "./config";
import type {
  CatalystStrength,
  MomentumSignal,
  NewsItem,
  PolicyAssessment,
  TradeDecision,
} from "./types";

export interface NewsGrabber {
  fetch(symbols: string[], lookbackHours: number): Promise<NewsItem[]>;
}

export interface PolicyAnalyst {
  evaluate(news: NewsItem[]): Promise<PolicyAssessment[]>;
}

export interface DecisionExecutor {
  decide(
    signals: MomentumSignal[],
    assessments: PolicyAssessment[],
    context: DecisionContext
  ): Promise<TradeDecision[]>;
}

export interface DecisionContext {
  totalEquityHkd: number;
  openSymbols: string[];
  config: HkMomentumPolicyConfig;
  riskBudgetHkd: number;
  symbolSectors?: Map<string, string[]>;
  openSectorCounts?: Map<string, number>;
}

export class ManualNewsGrabber implements NewsGrabber {
  constructor(private readonly source: () => NewsItem[]) {}
  async fetch(): Promise<NewsItem[]> {
    return this.source();
  }
}

const STRONG_KEYWORDS = [
  "AI",
  "算力",
  "再贷款",
  "设备更新",
  "十五五",
  "中报预增",
  "地产优化",
  "消费复苏",
  "国资",
  "回购",
];

const MEDIUM_KEYWORDS = ["补贴", "降准", "降息", "刺激", "新基建", "央企", "并购"];

export class KeywordPolicyAnalyst implements PolicyAnalyst {
  constructor(
    private readonly strongKeywords: string[] = STRONG_KEYWORDS,
    private readonly mediumKeywords: string[] = MEDIUM_KEYWORDS
  ) {}

  async evaluate(news: NewsItem[]): Promise<PolicyAssessment[]> {
    const out: PolicyAssessment[] = [];
    for (const item of news) {
      const text = `${item.title} ${item.summary} ${(item.keywords ?? []).join(" ")}`;
      const strongHits = this.strongKeywords.filter((k) => text.includes(k));
      const mediumHits = this.mediumKeywords.filter((k) => text.includes(k));
      let strength: CatalystStrength = "none";
      if (strongHits.length >= 1) strength = "strong";
      else if (mediumHits.length >= 1) strength = "medium";
      else strength = "weak";
      out.push({
        newsId: item.id,
        strength,
        reasoning: strongHits.length
          ? `命中强催化关键词: ${strongHits.join(", ")}`
          : mediumHits.length
            ? `命中中催化关键词: ${mediumHits.join(", ")}`
            : "无明确催化关键词",
        beneficiarySectors: item.sectors ?? [],
        beneficiarySymbols: item.symbols ?? [],
      });
    }
    return out;
  }
}

export class DefaultDecisionExecutor implements DecisionExecutor {
  async decide(
    signals: MomentumSignal[],
    assessments: PolicyAssessment[],
    context: DecisionContext
  ): Promise<TradeDecision[]> {
    const decisions: TradeDecision[] = [];
    const slotsLeft = Math.max(0, context.config.maxPositions - context.openSymbols.length);
    if (slotsLeft <= 0) return decisions;

    const symbolCatalysts = new Map<string, PolicyAssessment[]>();
    for (const a of assessments) {
      if (a.strength !== "strong" && a.strength !== "medium") continue;
      for (const s of a.beneficiarySymbols) {
        if (!symbolCatalysts.has(s)) symbolCatalysts.set(s, []);
        symbolCatalysts.get(s)!.push(a);
      }
    }

    const ranked = signals.filter((s) => !context.openSymbols.includes(s.symbol));
    const sectorCounts = new Map(context.openSectorCounts ?? new Map<string, number>());
    for (const sig of ranked) {
      if (decisions.length >= slotsLeft) break;
      const catalysts = symbolCatalysts.get(sig.symbol) ?? [];
      const hasStrong = catalysts.some((c) => c.strength === "strong");

      let entryMode: "catalyst" | "noCatalyst" | null = null;
      if (hasStrong) {
        entryMode = "catalyst";
      } else if (context.config.allowNoCatalystEntry) {
        const volOk = sig.volumeRatio >= context.config.noCatalystVolumeMultiplier;
        const breakoutOk = context.config.noCatalystBreakoutMustBeBoth
          ? sig.breakoutType === "both"
          : true;
        if (volOk && breakoutOk) entryMode = "noCatalyst";
      }
      if (!entryMode) continue;
      const sectors = context.symbolSectors?.get(sig.symbol) ?? [];
      const cap = context.config.maxPositionsPerSector;
      if (cap > 0 && sectors.some((sec) => (sectorCounts.get(sec) ?? 0) >= cap)) continue;

      const { stopLoss, takeProfit } = resolveStops(sig, context.config);
      const riskPerShare = sig.lastPrice - stopLoss;
      if (riskPerShare <= 0) continue;
      const perTradeRisk = context.totalEquityHkd * context.config.perTradeRiskPct;
      const riskMultiplier = entryMode === "noCatalyst" ? context.config.noCatalystRiskMultiplier : 1;
      const riskBudget = Math.min(perTradeRisk * riskMultiplier, context.riskBudgetHkd);
      if (riskBudget <= 0) continue;
      const rawShares = riskBudget / riskPerShare;
      const shares = Math.max(0, Math.floor(rawShares / 100) * 100);
      if (shares <= 0) continue;

      decisions.push({
        symbol: sig.symbol,
        name: sig.name,
        action: "enter",
        entryPrice: sig.lastPrice,
        stopLoss,
        takeProfit,
        trailingMa: context.config.trailingMa,
        positionSizeShares: shares,
        positionSizeNotional: shares * sig.lastPrice,
        reason:
          entryMode === "catalyst"
            ? `量比 ${sig.volumeRatio.toFixed(2)} 突破${sig.breakoutType}, RSI ${sig.rsi.toFixed(1)}, MACD柱 ${sig.macdHist.toFixed(3)}; 强催化: ${catalysts
                .filter((c) => c.strength === "strong")
                .map((c) => c.reasoning)
                .join(" | ")}`
            : `无催化-量价强势入场 (风险系数x${riskMultiplier.toFixed(2)}): 量比 ${sig.volumeRatio.toFixed(2)} 突破${sig.breakoutType}, RSI ${sig.rsi.toFixed(1)}, MACD柱 ${sig.macdHist.toFixed(3)}`,
        catalysts,
        signal: sig,
      });
      for (const sec of sectors) sectorCounts.set(sec, (sectorCounts.get(sec) ?? 0) + 1);
    }
    return decisions;
  }
}

function roundPrice(p: number): number {
  return Math.round(p * 1000) / 1000;
}

export function resolveStops(
  signal: MomentumSignal,
  config: HkMomentumPolicyConfig
): { stopLoss: number; takeProfit: number } {
  if (config.stopLossMode === "atr" && signal.atr && signal.atr > 0) {
    return {
      stopLoss: roundPrice(signal.lastPrice - signal.atr * config.atrStopMultiplier),
      takeProfit: roundPrice(signal.lastPrice + signal.atr * config.atrTakeProfitMultiplier),
    };
  }
  return {
    stopLoss: roundPrice(signal.lastPrice * (1 - config.stopLossPct)),
    takeProfit: roundPrice(signal.lastPrice * (1 + config.takeProfitPct)),
  };
}
