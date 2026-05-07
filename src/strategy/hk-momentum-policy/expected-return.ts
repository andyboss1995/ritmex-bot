export interface ScenarioParams {
  name: string;
  winRate: number;
  payoffRatio: number;
  tradesPerWeek: number;
  perTradeRiskPct: number;
  weeks: number;
  drawdownHaltPct: number;
  drawdownHaltDaysCooldown?: number;
}

export interface MonteCarloResult {
  scenario: string;
  paths: number;
  meanReturnPct: number;
  medianReturnPct: number;
  p05ReturnPct: number;
  p25ReturnPct: number;
  p75ReturnPct: number;
  p95ReturnPct: number;
  probDoubleEquity: number;
  probHaltTriggered: number;
  meanMaxDrawdownPct: number;
  expectedTradePnlPct: number;
  weeklyExpectedPct: number;
}

interface RandomSource {
  next(): number;
}

class Mulberry32 implements RandomSource {
  constructor(private state: number) {}
  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export function runMonteCarlo(params: ScenarioParams, paths = 10000, seed = 42): MonteCarloResult {
  const rng = new Mulberry32(seed);
  const totalTrades = Math.max(1, Math.round(params.tradesPerWeek * params.weeks));
  const winR = params.payoffRatio * params.perTradeRiskPct;
  const lossR = params.perTradeRiskPct;
  const expectedTradePnlPct = params.winRate * winR - (1 - params.winRate) * lossR;
  const weeklyExpectedPct = expectedTradePnlPct * params.tradesPerWeek;

  const finalReturns: number[] = new Array(paths);
  const maxDrawdowns: number[] = new Array(paths);
  let doubles = 0;
  let halts = 0;

  const haltCooldownTrades = Math.max(
    1,
    Math.round(((params.drawdownHaltDaysCooldown ?? 3) / 5) * params.tradesPerWeek)
  );
  for (let i = 0; i < paths; i++) {
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    let halted = false;
    let cooldown = 0;
    for (let t = 0; t < totalTrades; t++) {
      if (cooldown > 0) {
        cooldown--;
        continue;
      }
      const isWin = rng.next() < params.winRate;
      const r = isWin ? winR : -lossR;
      equity *= 1 + r;
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
      if (dd >= params.drawdownHaltPct) {
        halted = true;
        cooldown = haltCooldownTrades;
        peak = equity;
      }
    }
    finalReturns[i] = equity - 1;
    maxDrawdowns[i] = maxDd;
    if (equity >= 2) doubles++;
    if (halted) halts++;
  }

  finalReturns.sort((a, b) => a - b);
  const pct = (q: number) => finalReturns[Math.min(paths - 1, Math.floor(q * paths))]!;
  const mean = finalReturns.reduce((a, b) => a + b, 0) / paths;
  const meanDd = maxDrawdowns.reduce((a, b) => a + b, 0) / paths;

  return {
    scenario: params.name,
    paths,
    meanReturnPct: mean,
    medianReturnPct: pct(0.5),
    p05ReturnPct: pct(0.05),
    p25ReturnPct: pct(0.25),
    p75ReturnPct: pct(0.75),
    p95ReturnPct: pct(0.95),
    probDoubleEquity: doubles / paths,
    probHaltTriggered: halts / paths,
    meanMaxDrawdownPct: meanDd,
    expectedTradePnlPct,
    weeklyExpectedPct,
  };
}

export function formatMonteCarlo(r: MonteCarloResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  return [
    `[${r.scenario}] paths=${r.paths}`,
    `  单笔期望: ${pct(r.expectedTradePnlPct)} | 周期望: ${pct(r.weeklyExpectedPct)}`,
    `  半年回报 mean=${pct(r.meanReturnPct)} median=${pct(r.medianReturnPct)}`,
    `  分位 p05=${pct(r.p05ReturnPct)} p25=${pct(r.p25ReturnPct)} p75=${pct(r.p75ReturnPct)} p95=${pct(r.p95ReturnPct)}`,
    `  翻倍概率 P(>=2x)=${pct(r.probDoubleEquity)} | 触发回撤熔断概率=${pct(r.probHaltTriggered)} | 平均最大回撤=${pct(r.meanMaxDrawdownPct)}`,
  ].join("\n");
}

export const HK_MOMENTUM_SCENARIOS: ScenarioParams[] = [
  {
    name: "悲观 (低胜率/低盈亏比)",
    winRate: 0.35,
    payoffRatio: 1.8,
    tradesPerWeek: 4,
    perTradeRiskPct: 0.025,
    weeks: 26,
    drawdownHaltPct: 0.08,
  },
  {
    name: "基准 (历史动量+催化常见档)",
    winRate: 0.42,
    payoffRatio: 2.2,
    tradesPerWeek: 5,
    perTradeRiskPct: 0.025,
    weeks: 26,
    drawdownHaltPct: 0.08,
  },
  {
    name: "乐观 (强催化主升 + 严格执行)",
    winRate: 0.5,
    payoffRatio: 2.8,
    tradesPerWeek: 5,
    perTradeRiskPct: 0.025,
    weeks: 26,
    drawdownHaltPct: 0.08,
  },
];
