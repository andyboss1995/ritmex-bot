import { HK_MOMENTUM_SCENARIOS, formatMonteCarlo, runMonteCarlo } from "../src/strategy/hk-momentum-policy";

function main(): void {
  const paths = Number(process.env.MC_PATHS ?? 20000);
  console.log("# HK Momentum + Policy Catalyst — 半年预期收益 Monte Carlo 评估");
  console.log(`# paths=${paths} (单笔风险 2.5%, 单日上限 5%, 回撤熔断 8%)`);
  console.log("# 假设每笔输 = 触发止损 (-2.5% equity), 每笔赢 = 盈亏比 R × 2.5% equity");
  console.log("# 不含手续费/印花税/滑点估算 — 港股实盘需自行扣减约 0.15-0.25% 双边");
  console.log("");
  for (const sc of HK_MOMENTUM_SCENARIOS) {
    const r = runMonteCarlo(sc, paths, 42);
    console.log(formatMonteCarlo(r));
    console.log("");
  }
}

main();
