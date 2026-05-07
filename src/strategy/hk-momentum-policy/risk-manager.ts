import type { HkMomentumPolicyConfig } from "./config";
import type { AccountStateEntity, PositionEntity } from "./types";

export interface RiskGate {
  canOpen: boolean;
  reason?: string;
  remainingRiskBudgetHkd: number;
}

export class RiskManagerEntity {
  constructor(private readonly config: HkMomentumPolicyConfig) {}

  evaluate(account: AccountStateEntity, positions: PositionEntity[], now: string): RiskGate {
    if (account.haltedUntil && now < account.haltedUntil) {
      return { canOpen: false, reason: `回撤熔断中, 至 ${account.haltedUntil}`, remainingRiskBudgetHkd: 0 };
    }
    if (account.pausedUntil && now < account.pausedUntil) {
      return { canOpen: false, reason: `连亏暂停中, 至 ${account.pausedUntil}`, remainingRiskBudgetHkd: 0 };
    }
    const drawdown = account.peakEquityHkd > 0
      ? (account.peakEquityHkd - account.totalEquityHkd) / account.peakEquityHkd
      : 0;
    if (drawdown >= this.config.drawdownHaltPct) {
      return {
        canOpen: false,
        reason: `回撤 ${(drawdown * 100).toFixed(2)}% 超过 ${(this.config.drawdownHaltPct * 100).toFixed(0)}%`,
        remainingRiskBudgetHkd: 0,
      };
    }
    if (positions.length >= this.config.maxPositions) {
      return { canOpen: false, reason: "已达最大持仓数", remainingRiskBudgetHkd: 0 };
    }
    const dailyCap = account.totalEquityHkd * this.config.dailyRiskCapPct;
    const usedToday = Math.max(0, -account.realizedPnlToday);
    const remaining = Math.max(0, dailyCap - usedToday);
    if (remaining <= 0) {
      return { canOpen: false, reason: "单日风险额度已耗尽", remainingRiskBudgetHkd: 0 };
    }
    return { canOpen: true, remainingRiskBudgetHkd: remaining };
  }

  registerDailyClose(account: AccountStateEntity, now: string): AccountStateEntity {
    const history = [...account.realizedPnlHistory, account.realizedPnlToday];
    let pausedUntil = account.pausedUntil;
    let haltedUntil = account.haltedUntil;

    const tail = history.slice(-this.config.consecLossPause);
    if (tail.length === this.config.consecLossPause && tail.every((p) => p < 0)) {
      pausedUntil = nextDay(now, 1);
    }

    const peak = Math.max(account.peakEquityHkd, account.totalEquityHkd);
    const drawdown = peak > 0 ? (peak - account.totalEquityHkd) / peak : 0;
    if (drawdown >= this.config.drawdownHaltPct) {
      haltedUntil = nextDay(now, this.config.drawdownHaltDays);
    }

    return {
      ...account,
      realizedPnlToday: 0,
      realizedPnlHistory: history,
      peakEquityHkd: peak,
      pausedUntil,
      haltedUntil,
    };
  }
}

function nextDay(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}
