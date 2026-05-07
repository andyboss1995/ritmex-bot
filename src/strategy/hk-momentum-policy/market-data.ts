import type { NewsItem, SymbolSnapshot } from "./types";

export interface MarketDataSource {
  loadSnapshots(symbols: string[]): Promise<SymbolSnapshot[]>;
  loadNews?(symbols: string[], lookbackHours: number): Promise<NewsItem[]>;
}

export interface OrderRouter {
  submitMarketBuy(symbol: string, shares: number): Promise<{ orderId: string; filledPrice: number }>;
  submitStopLoss(symbol: string, shares: number, stopPrice: number): Promise<{ orderId: string }>;
  cancel(orderId: string): Promise<void>;
}
