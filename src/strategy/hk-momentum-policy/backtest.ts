import type { HkMomentumPolicyConfig } from "./config";
import { defaultConfig } from "./config";
import type { DecisionExecutor, NewsGrabber, PolicyAnalyst } from "./policy-agent";
import { DefaultDecisionExecutor, KeywordPolicyAnalyst } from "./policy-agent";
import { RiskManagerEntity } from "./risk-manager";
import { scanUniverse } from "./signal-engine";
import type {
  AccountStateEntity,
  DailyBar,
  NewsItem,
  PositionEntity,
  SymbolSnapshot,
  TradeDecision,
} from "./types";

export interface HistoricalSeries {
  symbol: string;
  name: string;
  bars: DailyBar[];
}

export interface BacktestInput {
  series: HistoricalSeries[];
  newsByDate: Record<string, NewsItem[]>;
  initialEquityHkd: number;
  config?: Partial<HkMomentumPolicyConfig>;
  policyAnalyst?: PolicyAnalyst;
  decisionExecutor?: DecisionExecutor;
  warmupBars?: number;
  symbolSectors?: Map<string, string[]>;
}

export interface ClosedTradeEntity {
  symbol: string;
  name: string;
  openedAt: string;
  closedAt: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  pnlHkd: number;
  returnPct: number;
  exitReason: "stop" | "takeProfit" | "trailing" | "timeout" | "endOfData" | "portfolioHalt";
}

export interface BacktestResult {
  trades: ClosedTradeEntity[];
  finalEquityHkd: number;
  totalReturnPct: number;
  cagrAnnualized: number;
  winRate: number;
  payoffRatio: number;
  expectancyPerTrade: number;
  maxDrawdownPct: number;
  sharpeDaily: number;
  equityCurve: Array<{ date: string; equity: number }>;
}

const dayMs = 86400000;

export class BacktestEngineEntity {
  private readonly config: HkMomentumPolicyConfig;
  private readonly risk: RiskManagerEntity;
  private readonly analyst: PolicyAnalyst;
  private readonly executor: DecisionExecutor;

  constructor(input: BacktestInput) {
    this.config = { ...defaultConfig, ...(input.config ?? {}) };
    this.risk = new RiskManagerEntity(this.config);
    this.analyst = input.policyAnalyst ?? new KeywordPolicyAnalyst();
    this.executor = input.decisionExecutor ?? new DefaultDecisionExecutor();
  }

  async run(input: BacktestInput): Promise<BacktestResult> {
    const allDates = collectTradingDates(input.series);
    const warmup = input.warmupBars ?? Math.max(this.config.breakoutSmaWindow, this.config.macdSlow + this.config.macdSignal);
    const seriesBySymbol = new Map(input.series.map((s) => [s.symbol, s]));

    const account: AccountStateEntity = {
      totalEquityHkd: input.initialEquityHkd,
      realizedPnlToday: 0,
      realizedPnlHistory: [],
      peakEquityHkd: input.initialEquityHkd,
    };
    let positions: PositionEntity[] = [];
    const trades: ClosedTradeEntity[] = [];
    const equityCurve: Array<{ date: string; equity: number }> = [];
    const dailyReturns: number[] = [];

    let pendingEntries: TradeDecision[] = [];

    for (let i = warmup; i < allDates.length; i++) {
      const date = allDates[i]!;
      const prevEquity = markToMarket(account.totalEquityHkd, positions, seriesBySymbol, date, "open");

      if (this.config.entryTiming === "next_open") {
        const executedToday = executePendingEntries(pendingEntries, seriesBySymbol, date, positions, this.config, "open");
        pendingEntries = [];
        positions = executedToday.positions;
      }

      const exitedToday = processIntradayExits(positions, seriesBySymbol, date, this.config);
      positions = exitedToday.positions;
      for (const t of exitedToday.closed) {
        trades.push(t);
        account.realizedPnlToday += t.pnlHkd;
        account.totalEquityHkd += t.pnlHkd;
      }

      // Portfolio-level 实时回撤检查 (15% 上限): 用当日各持仓 LOW 估算盘中最差权益,
      // 触发即清仓 + 冷静期
      if (positions.length > 0 && account.peakEquityHkd > 0) {
        const intradayLowEquity = markToMarket(account.totalEquityHkd, positions, seriesBySymbol, date, "low");
        const intradayDd = (account.peakEquityHkd - intradayLowEquity) / account.peakEquityHkd;
        if (intradayDd >= this.config.intradayDrawdownHaltPct) {
          // 强制清仓: 每只在能让组合在 15% 阈值平仓的近似价 (取 max(low, 阈值价))
          const targetEquity = account.peakEquityHkd * (1 - this.config.intradayDrawdownHaltPct);
          const forcedExits = forceCloseAtThreshold(positions, seriesBySymbol, date, account.totalEquityHkd, targetEquity);
          for (const t of forcedExits) {
            trades.push(t);
            account.realizedPnlToday += t.pnlHkd;
            account.totalEquityHkd += t.pnlHkd;
          }
          positions = [];
          account.haltedUntil = nextTradingDay(allDates, i, this.config.intradayHaltCooldownDays);
          pendingEntries = [];
        }
      }

      const snapshots: SymbolSnapshot[] = [];
      for (const s of input.series) {
        const idx = s.bars.findIndex((b) => b.date === date);
        if (idx < warmup) continue;
        const todayBar = s.bars[idx]!;
        snapshots.push({
          symbol: s.symbol,
          name: s.name,
          bars: s.bars.slice(0, idx),
          lastPrice: todayBar.close,
          preClose: s.bars[idx - 1]!.close,
          intradayVolume: todayBar.volume,
        });
      }

      const signals = scanUniverse(snapshots, this.config, isoOf(date));
      const news = input.newsByDate[date] ?? [];
      const assessments = await this.analyst.evaluate(news);

      // Market regime cap override
    let maxSlotsOverride: number | undefined;
    if (this.config.requireMarketAboveSma && this.config.broadMarketSymbol) {
      const broad = seriesBySymbol.get(this.config.broadMarketSymbol);
      if (broad) {
        const idx = broad.bars.findIndex((b) => b.date === date);
        if (idx >= this.config.marketSmaPeriod) {
          const recent = broad.bars.slice(idx - this.config.marketSmaPeriod, idx).map((b) => b.close);
          const ma = recent.reduce((a, b) => a + b, 0) / this.config.marketSmaPeriod;
          const last = broad.bars[idx - 1]!.close;
          const regimeOk = last >= ma;
          if (this.config.bullMaxPositions && regimeOk) maxSlotsOverride = this.config.bullMaxPositions;
          if (this.config.bearMaxPositions && !regimeOk) maxSlotsOverride = this.config.bearMaxPositions;
        }
      }
    }

    const gate = this.risk.evaluate(account, positions, isoOf(date));
      let decisions: TradeDecision[] = [];
      if (gate.canOpen) {
        const openSectorCounts = new Map<string, number>();
        if (input.symbolSectors) {
          for (const p of positions) {
            const secs = input.symbolSectors.get(p.symbol) ?? [];
            for (const s of secs) openSectorCounts.set(s, (openSectorCounts.get(s) ?? 0) + 1);
          }
        }
        decisions = await this.executor.decide(signals, assessments, {
          totalEquityHkd: account.totalEquityHkd,
          openSymbols: positions.map((p) => p.symbol),
          config: maxSlotsOverride ? { ...this.config, maxPositions: maxSlotsOverride } : this.config,
          riskBudgetHkd: gate.remainingRiskBudgetHkd,
          symbolSectors: input.symbolSectors,
          openSectorCounts,
        });
      }
      if (this.config.entryTiming === "same_close") {
        const executedNow = executePendingEntries(decisions, seriesBySymbol, date, positions, this.config, "close");
        positions = executedNow.positions;
        pendingEntries = [];
      } else {
        pendingEntries = decisions;
      }

      // Step 4: close-of-day mark-to-market & equity curve
      const eod = markToMarket(account.totalEquityHkd, positions, seriesBySymbol, date, "close");
      equityCurve.push({ date, equity: eod });
      if (prevEquity > 0) dailyReturns.push((eod - prevEquity) / prevEquity);

      // Step 5: register daily close (loss streak / drawdown halt)
      const updatedAccount = this.risk.registerDailyClose(account, isoOf(date));
      account.realizedPnlToday = updatedAccount.realizedPnlToday;
      account.realizedPnlHistory = updatedAccount.realizedPnlHistory;
      account.peakEquityHkd = Math.max(updatedAccount.peakEquityHkd, eod);
      account.pausedUntil = updatedAccount.pausedUntil;
      account.haltedUntil = updatedAccount.haltedUntil;
    }

    // Force close at end
    const lastDate = allDates[allDates.length - 1]!;
    for (const p of positions) {
      const s = seriesBySymbol.get(p.symbol);
      if (!s) continue;
      const bar = s.bars.find((b) => b.date === lastDate);
      if (!bar) continue;
      const pnl = (bar.close - p.entryPrice) * p.shares;
      trades.push({
        symbol: p.symbol,
        name: p.name,
        openedAt: p.openedAt,
        closedAt: lastDate,
        entryPrice: p.entryPrice,
        exitPrice: bar.close,
        shares: p.shares,
        pnlHkd: pnl,
        returnPct: pnl / (p.entryPrice * p.shares),
        exitReason: "endOfData",
      });
      account.totalEquityHkd += pnl;
    }

    return summarize(trades, equityCurve, dailyReturns, input.initialEquityHkd, account.totalEquityHkd, allDates.length - warmup);
  }
}

function collectTradingDates(series: HistoricalSeries[]): string[] {
  const set = new Set<string>();
  for (const s of series) for (const b of s.bars) set.add(b.date);
  return Array.from(set).sort();
}

function isoOf(date: string): string {
  return new Date(date + "T08:00:00.000Z").toISOString();
}

function markToMarket(
  cashEquity: number,
  positions: PositionEntity[],
  seriesBySymbol: Map<string, HistoricalSeries>,
  date: string,
  mode: "open" | "close" | "low" | "high"
): number {
  let equity = cashEquity;
  for (const p of positions) {
    const s = seriesBySymbol.get(p.symbol);
    if (!s) continue;
    const bar = s.bars.find((b) => b.date === date);
    if (!bar) continue;
    const px = mode === "open" ? bar.open : mode === "close" ? bar.close : mode === "low" ? bar.low : bar.high;
    equity += (px - p.entryPrice) * p.shares;
  }
  return equity;
}

function forceCloseAtThreshold(
  positions: PositionEntity[],
  seriesBySymbol: Map<string, HistoricalSeries>,
  date: string,
  cashEquity: number,
  targetEquity: number
): ClosedTradeEntity[] {
  // 求一个 alpha ∈ [0,1] 使得用 close 与 low 之间插值价后总市值 ≈ targetEquity.
  // 这模拟"盘中触发熔断, 在 close 与 low 之间某个时刻平仓"
  const closeMtm = markToMarket(cashEquity, positions, seriesBySymbol, date, "close");
  const lowMtm = markToMarket(cashEquity, positions, seriesBySymbol, date, "low");
  const range = closeMtm - lowMtm;
  let alpha = 1;
  if (range > 1e-9 && targetEquity < closeMtm) {
    alpha = Math.max(0, Math.min(1, (closeMtm - targetEquity) / range));
  }
  const closed: ClosedTradeEntity[] = [];
  for (const p of positions) {
    const s = seriesBySymbol.get(p.symbol);
    if (!s) continue;
    const bar = s.bars.find((b) => b.date === date);
    if (!bar) continue;
    const exitPx = bar.close - alpha * (bar.close - bar.low);
    const pnl = (exitPx - p.entryPrice) * p.shares;
    closed.push({
      symbol: p.symbol,
      name: p.name,
      openedAt: p.openedAt,
      closedAt: date,
      entryPrice: p.entryPrice,
      exitPrice: exitPx,
      shares: p.shares,
      pnlHkd: pnl,
      returnPct: pnl / (p.entryPrice * p.shares),
      exitReason: "portfolioHalt",
    });
  }
  return closed;
}

function nextTradingDay(allDates: string[], idx: number, n: number): string {
  const target = Math.min(allDates.length - 1, idx + n);
  return new Date(allDates[target] + "T08:00:00.000Z").toISOString();
}

function executePendingEntries(
  pending: TradeDecision[],
  seriesBySymbol: Map<string, HistoricalSeries>,
  date: string,
  positions: PositionEntity[],
  config: HkMomentumPolicyConfig,
  fillMode: "open" | "close"
): { positions: PositionEntity[] } {
  const out = [...positions];
  for (const d of pending) {
    if (out.length >= config.maxPositions) break;
    if (out.some((p) => p.symbol === d.symbol)) continue;
    const s = seriesBySymbol.get(d.symbol);
    if (!s) continue;
    const idx = s.bars.findIndex((b) => b.date === date);
    if (idx < 0) continue;
    const bar = s.bars[idx]!;
    const fillPrice = fillMode === "open" ? bar.open : bar.close;
    if (!Number.isFinite(fillPrice) || fillPrice <= 0) continue;
    const { stopLoss, takeProfit } = computeStops(fillPrice, s, idx, config);
    if (stopLoss >= fillPrice) continue;
    out.push({
      symbol: d.symbol,
      name: d.name,
      side: "long",
      entryPrice: fillPrice,
      stopLoss,
      takeProfit,
      shares: d.positionSizeShares,
      openedAt: date,
      partialTaken: false,
      trailingHigh: fillPrice,
    });
  }
  return { positions: out };
}

function computeStops(
  fillPrice: number,
  s: HistoricalSeries,
  idx: number,
  config: HkMomentumPolicyConfig
): { stopLoss: number; takeProfit: number } {
  if (config.stopLossMode === "atr") {
    const atr = computeAtr(s.bars, idx, config.atrPeriod);
    if (Number.isFinite(atr) && atr > 0) {
      return {
        stopLoss: fillPrice - atr * config.atrStopMultiplier,
        takeProfit: fillPrice + atr * config.atrTakeProfitMultiplier,
      };
    }
  }
  return {
    stopLoss: fillPrice * (1 - config.stopLossPct),
    takeProfit: fillPrice * (1 + config.takeProfitPct),
  };
}

function computeAtr(bars: DailyBar[], idx: number, period: number): number {
  const start = Math.max(1, idx - period);
  if (idx - start < period - 1) return NaN;
  let sum = 0;
  let count = 0;
  for (let i = start; i < idx; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(b.high - b.low, Math.abs(b.high - prev.close), Math.abs(b.low - prev.close));
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : NaN;
}

function processIntradayExits(
  positions: PositionEntity[],
  seriesBySymbol: Map<string, HistoricalSeries>,
  date: string,
  config: HkMomentumPolicyConfig
): { positions: PositionEntity[]; closed: ClosedTradeEntity[] } {
  const remaining: PositionEntity[] = [];
  const closed: ClosedTradeEntity[] = [];
  for (const p of positions) {
    const s = seriesBySymbol.get(p.symbol);
    if (!s) {
      remaining.push(p);
      continue;
    }
    const bar = s.bars.find((b) => b.date === date);
    if (!bar) {
      remaining.push(p);
      continue;
    }
    const newHigh = Math.max(p.trailingHigh, bar.high);
    const trailing = computeTrailingStop(p, s, date, config);

    // pessimistic: assume worst case order — gap/intraday hit stop first, then take-profit
    if (bar.low <= p.stopLoss) {
      closed.push(makeClosed(p, date, p.stopLoss, "stop"));
      continue;
    }
    if (!p.partialTaken && bar.high >= p.takeProfit) {
      const partialShares = Math.floor((p.shares * config.takeProfitPartial) / 100) * 100;
      const remainShares = p.shares - partialShares;
      if (partialShares > 0) {
        const partialPnl = (p.takeProfit - p.entryPrice) * partialShares;
        closed.push({
          symbol: p.symbol,
          name: p.name,
          openedAt: p.openedAt,
          closedAt: date,
          entryPrice: p.entryPrice,
          exitPrice: p.takeProfit,
          shares: partialShares,
          pnlHkd: partialPnl,
          returnPct: (p.takeProfit - p.entryPrice) / p.entryPrice,
          exitReason: "takeProfit",
        });
      }
      if (remainShares > 0) {
        // Move stop to break-even after partial profit + apply trailing
        const newStop = Math.max(p.entryPrice, trailing);
        if (bar.close < newStop) {
          closed.push(makeClosed({ ...p, shares: remainShares, stopLoss: newStop }, date, bar.close, "trailing"));
        } else {
          remaining.push({
            ...p,
            shares: remainShares,
            partialTaken: true,
            stopLoss: newStop,
            trailingHigh: newHigh,
          });
        }
      }
      continue;
    }
    if (p.partialTaken && Number.isFinite(trailing) && bar.low <= trailing) {
      closed.push(makeClosed(p, date, trailing, "trailing"));
      continue;
    }
    remaining.push({ ...p, trailingHigh: newHigh });
  }
  return { positions: remaining, closed };
}

function computeTrailingStop(
  p: PositionEntity,
  s: HistoricalSeries,
  date: string,
  config: HkMomentumPolicyConfig
): number {
  const idx = s.bars.findIndex((b) => b.date === date);
  if (idx < config.trailingMa) return -Infinity;
  const slice = s.bars.slice(idx - config.trailingMa, idx);
  let sum = 0;
  for (const b of slice) sum += b.close;
  return sum / config.trailingMa;
}

function makeClosed(
  p: PositionEntity,
  date: string,
  exitPrice: number,
  reason: ClosedTradeEntity["exitReason"]
): ClosedTradeEntity {
  const pnl = (exitPrice - p.entryPrice) * p.shares;
  return {
    symbol: p.symbol,
    name: p.name,
    openedAt: p.openedAt,
    closedAt: date,
    entryPrice: p.entryPrice,
    exitPrice,
    shares: p.shares,
    pnlHkd: pnl,
    returnPct: (exitPrice - p.entryPrice) / p.entryPrice,
    exitReason: reason,
  };
}

function summarize(
  trades: ClosedTradeEntity[],
  equityCurve: Array<{ date: string; equity: number }>,
  dailyReturns: number[],
  initialEquity: number,
  finalEquity: number,
  tradingDays: number
): BacktestResult {
  const wins = trades.filter((t) => t.pnlHkd > 0);
  const losses = trades.filter((t) => t.pnlHkd <= 0);
  const winRate = trades.length ? wins.length / trades.length : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) : 0;
  const payoffRatio = avgLoss > 0 ? avgWin / avgLoss : Infinity;
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;
  const totalReturn = (finalEquity - initialEquity) / initialEquity;
  const years = Math.max(1 / 252, tradingDays / 252);
  const cagr = Math.pow(1 + totalReturn, 1 / years) - 1;

  let peak = -Infinity;
  let maxDd = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const dd = (peak - point.equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  const stdev = Math.sqrt(variance);
  const sharpeDaily = stdev > 0 ? (mean / stdev) * Math.sqrt(252) : 0;

  return {
    trades,
    finalEquityHkd: finalEquity,
    totalReturnPct: totalReturn,
    cagrAnnualized: cagr,
    winRate,
    payoffRatio,
    expectancyPerTrade: expectancy,
    maxDrawdownPct: maxDd,
    sharpeDaily,
    equityCurve,
  };
}
