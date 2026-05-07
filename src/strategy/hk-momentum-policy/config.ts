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
};
