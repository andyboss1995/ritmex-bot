import type { MarketDataSource, OrderRouter } from "../market-data";
import type { NewsItem, SymbolSnapshot } from "../types";

export interface FutuOpenApiOptions {
  host?: string;
  port?: number;
  trdEnv?: "SIMULATE" | "REAL";
  trdMarket?: "HK" | "US" | "CN";
  unlockPwdMd5?: string;
}

export interface FutuClient {
  qotGetKL(req: { symbol: string; klType: number; reqNum: number }): Promise<{
    klList: Array<{
      time_key: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      turnover: number;
    }>;
  }>;
  qotGetBasicQot(req: { symbol: string }): Promise<{
    last: number;
    preClose: number;
    volume: number;
    name: string;
  }>;
  newsGet?(req: { symbol?: string; lookbackHours: number }): Promise<NewsItem[]>;
  trdPlaceOrder?(req: {
    symbol: string;
    qty: number;
    side: "BUY" | "SELL";
    orderType: "MARKET" | "STOP";
    price?: number;
  }): Promise<{ orderId: string; filledPrice?: number }>;
  trdCancelOrder?(orderId: string): Promise<void>;
}

export class FutuMarketDataSource implements MarketDataSource {
  constructor(private readonly client: FutuClient) {}

  async loadSnapshots(symbols: string[]): Promise<SymbolSnapshot[]> {
    const out: SymbolSnapshot[] = [];
    for (const symbol of symbols) {
      const [kl, quote] = await Promise.all([
        this.client.qotGetKL({ symbol, klType: 2, reqNum: 60 }),
        this.client.qotGetBasicQot({ symbol }),
      ]);
      const bars = kl.klList.map((k) => ({
        date: k.time_key,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        turnover: k.turnover,
      }));
      out.push({
        symbol,
        name: quote.name,
        bars,
        lastPrice: quote.last,
        preClose: quote.preClose,
        intradayVolume: quote.volume,
      });
    }
    return out;
  }

  async loadNews(symbols: string[], lookbackHours: number): Promise<NewsItem[]> {
    if (!this.client.newsGet) return [];
    const all: NewsItem[] = [];
    for (const s of symbols) {
      const items = await this.client.newsGet({ symbol: s, lookbackHours });
      all.push(...items);
    }
    return all;
  }
}

export class FutuOrderRouter implements OrderRouter {
  constructor(private readonly client: FutuClient) {}

  async submitMarketBuy(symbol: string, shares: number) {
    if (!this.client.trdPlaceOrder) throw new Error("FutuClient.trdPlaceOrder 未实现");
    const r = await this.client.trdPlaceOrder({ symbol, qty: shares, side: "BUY", orderType: "MARKET" });
    return { orderId: r.orderId, filledPrice: r.filledPrice ?? NaN };
  }

  async submitStopLoss(symbol: string, shares: number, stopPrice: number) {
    if (!this.client.trdPlaceOrder) throw new Error("FutuClient.trdPlaceOrder 未实现");
    const r = await this.client.trdPlaceOrder({
      symbol,
      qty: shares,
      side: "SELL",
      orderType: "STOP",
      price: stopPrice,
    });
    return { orderId: r.orderId };
  }

  async cancel(orderId: string): Promise<void> {
    if (!this.client.trdCancelOrder) throw new Error("FutuClient.trdCancelOrder 未实现");
    await this.client.trdCancelOrder(orderId);
  }
}
