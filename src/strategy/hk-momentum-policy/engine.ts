import type { HkMomentumPolicyConfig } from "./config";
import { defaultConfig } from "./config";
import { buildDailyReport, type DailyReportInput } from "./daily-report";
import type { MarketDataSource, OrderRouter } from "./market-data";
import type { DecisionExecutor, NewsGrabber, PolicyAnalyst } from "./policy-agent";
import { DefaultDecisionExecutor, KeywordPolicyAnalyst } from "./policy-agent";
import { RiskManagerEntity } from "./risk-manager";
import { scanUniverse } from "./signal-engine";
import type {
  AccountStateEntity,
  MomentumSignal,
  NewsItem,
  PolicyAssessment,
  PositionEntity,
  TradeDecision,
} from "./types";

export interface EngineDeps {
  marketData: MarketDataSource;
  newsGrabber: NewsGrabber;
  policyAnalyst?: PolicyAnalyst;
  decisionExecutor?: DecisionExecutor;
  orderRouter?: OrderRouter;
  config?: Partial<HkMomentumPolicyConfig>;
  symbolSectors?: Map<string, string[]>;
}

export interface EngineRunInput {
  universe: string[];
  account: AccountStateEntity;
  positions: PositionEntity[];
  now?: string;
  lookbackHours?: number;
}

export interface EngineRunResult {
  signals: MomentumSignal[];
  news: NewsItem[];
  assessments: PolicyAssessment[];
  decisions: TradeDecision[];
  riskGateReason?: string;
}

export class HkMomentumPolicyEngineEntity {
  private readonly config: HkMomentumPolicyConfig;
  private readonly risk: RiskManagerEntity;
  private readonly analyst: PolicyAnalyst;
  private readonly executor: DecisionExecutor;

  constructor(private readonly deps: EngineDeps) {
    this.config = { ...defaultConfig, ...(deps.config ?? {}) };
    this.risk = new RiskManagerEntity(this.config);
    this.analyst = deps.policyAnalyst ?? new KeywordPolicyAnalyst();
    this.executor = deps.decisionExecutor ?? new DefaultDecisionExecutor();
  }

  async run(input: EngineRunInput): Promise<EngineRunResult> {
    const now = input.now ?? new Date().toISOString();
    const snapshots = await this.deps.marketData.loadSnapshots(input.universe);
    const signals = scanUniverse(snapshots, this.config, now);
    const news = await this.deps.newsGrabber.fetch(input.universe, input.lookbackHours ?? 36);
    const assessments = await this.analyst.evaluate(news);

    // Market regime filter: if requireMarketAboveSma is enabled and broadMarketSymbol provided,
    // reduce or halt positions when market is below SMA.
    let regimeOk = true;
    let maxSlotsOverride: number | undefined;
    if (this.config.requireMarketAboveSma && this.config.broadMarketSymbol) {
      const mkt = snapshots.find((s) => s.symbol === this.config.broadMarketSymbol);
      if (mkt && mkt.bars.length >= this.config.marketSmaPeriod) {
        const closes = mkt.bars.map((b) => b.close);
        const recent = closes.slice(-this.config.marketSmaPeriod);
        const ma = recent.reduce((a, b) => a + b, 0) / this.config.marketSmaPeriod;
        regimeOk = mkt.lastPrice >= ma;
        if (this.config.bullMaxPositions && regimeOk) maxSlotsOverride = this.config.bullMaxPositions;
        if (this.config.bearMaxPositions && !regimeOk) maxSlotsOverride = this.config.bearMaxPositions;
      }
    }

    const gate = this.risk.evaluate(
      maxSlotsOverride ? { ...input.account } : input.account,
      input.positions,
      now,
      maxSlotsOverride
    );
    if (!gate.canOpen) {
      return { signals, news, assessments, decisions: [], riskGateReason: gate.reason };
    }

    const openSectorCounts = new Map<string, number>();
    if (this.deps.symbolSectors) {
      for (const p of input.positions) {
        const secs = this.deps.symbolSectors.get(p.symbol) ?? [];
        for (const s of secs) openSectorCounts.set(s, (openSectorCounts.get(s) ?? 0) + 1);
      }
    }
    const decisions = await this.executor.decide(signals, assessments, {
      totalEquityHkd: input.account.totalEquityHkd,
      openSymbols: input.positions.map((p) => p.symbol),
      config: maxSlotsOverride ? { ...this.config, maxPositions: maxSlotsOverride } : this.config,
      riskBudgetHkd: gate.remainingRiskBudgetHkd,
      symbolSectors: this.deps.symbolSectors,
      openSectorCounts,
    });

    return { signals, news, assessments, decisions };
  }

  buildReport(args: Omit<DailyReportInput, "riskGateReason"> & { riskGateReason?: string }): string {
    return buildDailyReport(args);
  }

  closeDay(account: AccountStateEntity, now: string): AccountStateEntity {
    return this.risk.registerDailyClose(account, now);
  }

  get effectiveConfig(): HkMomentumPolicyConfig {
    return this.config;
  }
}
