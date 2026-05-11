export interface HkMomentumPolicyConfig {
  volumeLookback: number;
  volumeMultiplier: number;
  breakoutSmaWindow: number;
  breakoutHighWindow: number;
  rsiPeriod: number;
  rsiThreshold: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  maxPositions: number;
  perTradeRiskPct: number;
  dailyRiskCapPct: number;
  stopLossPct: number;
  takeProfitPct: number;
  takeProfitPartial: number;
  trailingMa: number;
  consecLossPause: number;
  drawdownHaltPct: number;
  drawdownHaltDays: number;
  intradayDrawdownHaltPct: number;
  intradayHaltCooldownDays: number;
  maxPositionsPerSector: number;
  minDailyTurnoverHkd: number;
  entryTiming: "next_open" | "same_close";
  stopLossMode: "fixed" | "atr";
  atrPeriod: number;
  atrStopMultiplier: number;
  atrTakeProfitMultiplier: number;
  allowNoCatalystEntry: boolean;
  noCatalystVolumeMultiplier: number;
  noCatalystBreakoutMustBeBoth: boolean;
  noCatalystRiskMultiplier: number;
  requireMarketAboveSma: boolean;
  marketSmaPeriod: number;
  broadMarketSymbol?: string;
  bullMaxPositions?: number;
  bearMaxPositions?: number;
}

export const defaultConfig: HkMomentumPolicyConfig = {
  volumeLookback: 5,
  volumeMultiplier: 1.5,
  breakoutSmaWindow: 20,
  breakoutHighWindow: 20,
  rsiPeriod: 14,
  rsiThreshold: 50,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  maxPositions: 3,
  perTradeRiskPct: 0.025,
  dailyRiskCapPct: 0.05,
  stopLossPct: 0.018,
  takeProfitPct: 0.05,
  takeProfitPartial: 0.5,
  trailingMa: 10,
  consecLossPause: 2,
  drawdownHaltPct: 0.08,
  drawdownHaltDays: 3,
  intradayDrawdownHaltPct: 0.15,
  intradayHaltCooldownDays: 5,
  maxPositionsPerSector: 2,
  minDailyTurnoverHkd: 1_000_000_000,
  entryTiming: "next_open",
  stopLossMode: "fixed",
  atrPeriod: 14,
  atrStopMultiplier: 1.2,
  atrTakeProfitMultiplier: 3.0,
  allowNoCatalystEntry: false,
  noCatalystVolumeMultiplier: 2.0,
  noCatalystBreakoutMustBeBoth: true,
  noCatalystRiskMultiplier: 0.5,
  requireMarketAboveSma: false,
  marketSmaPeriod: 20,
  broadMarketSymbol: undefined,
  bullMaxPositions: undefined,
  bearMaxPositions: 1,
};

export const aggressiveConfig: HkMomentumPolicyConfig = {
  ...defaultConfig,
  volumeMultiplier: 2.0,
  maxPositions: 4,
  perTradeRiskPct: 0.05,
  dailyRiskCapPct: 0.08,
  stopLossMode: "atr",
  atrPeriod: 14,
  atrStopMultiplier: 1.5,
  atrTakeProfitMultiplier: 3.5,
  trailingMa: 8,
  drawdownHaltPct: 0.12,
  intradayDrawdownHaltPct: 0.20,
  intradayHaltCooldownDays: 3,
  minDailyTurnoverHkd: 500_000_000,
  entryTiming: "same_close",
  allowNoCatalystEntry: true,
  noCatalystVolumeMultiplier: 2.5,
  noCatalystBreakoutMustBeBoth: true,
  noCatalystRiskMultiplier: 0.6,
  requireMarketAboveSma: true,
  marketSmaPeriod: 20,
  bullMaxPositions: 5,
  bearMaxPositions: 1,
};
