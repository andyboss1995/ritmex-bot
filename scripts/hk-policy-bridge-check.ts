/** 验证 Python ↔ TS bridge 工作正常: 拉账户 + 持仓, 不下单. */
import { resolve } from "node:path";
import { FutuTradeBridge } from "../src/strategy/hk-momentum-policy";

async function main(): Promise<void> {
  const env = (process.env.FUTU_TRD_ENV ?? "SIMULATE") as "SIMULATE" | "REAL";
  const bridge = new FutuTradeBridge({
    daemonScript: resolve(process.cwd(), "scripts/futu_trade_daemon.py"),
    host: process.env.FUTU_HOST ?? "127.0.0.1",
    port: Number(process.env.FUTU_PORT ?? 11111),
    env, market: "HK",
    unlockPwdMd5: process.env.FUTU_UNLOCK_PWD_MD5,
    onLog: (l) => console.error(l),
  });
  await bridge.start();
  console.log(`bridge ready (env=${env})`);

  try {
    const h = await bridge.health();
    console.log(`health: market_hk=${h.market_hk}`);
    const acc = await bridge.getAccount();
    console.log(`account: 总资产=${acc.totalAssets} ${acc.currency} 现金=${acc.cash} 持仓市值=${acc.marketVal}`);
    const pos = await bridge.getPositions();
    console.log(`positions: ${pos.length} 只`);
    for (const p of pos) {
      console.log(`  ${p.symbol} ${p.name}: ${p.qty} 股 cost=${p.costPrice} cur=${p.currentPrice} pnl=${p.plRatio.toFixed(2)}% (${p.plVal.toFixed(0)} HKD)`);
    }
  } finally {
    await bridge.stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
