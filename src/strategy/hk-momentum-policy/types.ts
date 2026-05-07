export type CatalystStrength = "strong" | "medium" | "weak" | "none";

export type Side = "long";

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  turnover: number;
}

export interface SymbolSnapshot {
  symbol: string;
  name: string;
  sector?: string;
  bars: DailyBar[];
  lastPrice: number;
  preClose: number;
  intradayVolume: number;
}

export interface NewsItem {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  summary: string;
  symbols?: string[];
  sectors?: string[];
  keywords?: string[];
}

export interface PolicyAssessment {
  newsId: string;
  strength: CatalystStrength;
  reasoning: string;
  beneficiarySectors: string[];
  beneficiarySymbols: string[];
}

export interface MomentumSignal {
  symbol: string;
  name: string;
  triggeredAt: string;
  lastPrice: number;
  volumeRatio: number;
  sma20: number;
  high20: number;
  rsi: number;
  macdHist: number;
  breakoutType: "sma" | "high" | "both";
  atr?: number;
}

export interface TradeDecision {
  symbol: string;
  name: string;
  action: "enter" | "skip";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingMa: number;
  positionSizeShares: number;
  positionSizeNotional: number;
  reason: string;
  catalysts: PolicyAssessment[];
  signal: MomentumSignal;
}

export interface PositionEntity {
  symbol: string;
  name: string;
  side: Side;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  shares: number;
  openedAt: string;
  partialTaken: boolean;
  trailingHigh: number;
}

export interface AccountStateEntity {
  totalEquityHkd: number;
  realizedPnlToday: number;
  realizedPnlHistory: number[];
  peakEquityHkd: number;
  haltedUntil?: string;
  pausedUntil?: string;
}
