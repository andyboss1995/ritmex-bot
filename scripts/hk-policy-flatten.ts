/**
 * 一键平掉 SIMULATE/REAL 账户当前所有港股持仓 (市价卖出可卖部分).
 *
 * 用法:
 *   bun run scripts/hk-policy-flatten.ts            # 列出, 等 yes 确认
 *   bun run scripts/hk-policy-flatten.ts --auto     # 直接平
 *   bun run scripts/hk-policy-flatten.ts --only HK.09868,HK.01211   # 仅平指定
 *
 * REAL 模式必须设置 FUTU_UNLOCK_PWD_MD5.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { FutuTradeBridge } from "../src/strategy/hk-momentum-policy";

function parseOnly(): Set<string> | null {
  const idx = process.argv.indexOf("--only");
  if (idx < 0 || idx + 1 >= process.argv.length) return null;
  return new Set(process.argv[idx + 1]!.split(",").map((s) => s.trim()).filter(Boolean));
}

function isAutoMode(): boolean {
  return process.argv.includes("--auto") || process.argv.includes("--yes") || process.env.HK_AUTO_CONFIRM === "1";
}

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

async function main(): Promise<void> {
  const env = (process.env.FUTU_TRD_ENV ?? "SIMULATE") as "SIMULATE" | "REAL";
  const host = process.env.FUTU_HOST ?? "127.0.0.1";
  const port = Number(process.env.FUTU_PORT ?? 11111);
  const unlockPwdMd5 = process.env.FUTU_UNLOCK_PWD_MD5;
  if (env === "REAL" && !unlockPwdMd5) {
    console.error("REAL 模式必须设置 FUTU_UNLOCK_PWD_MD5");
    process.exit(1);
  }
  const only = parseOnly();
  const auto = isAutoMode();

  const bridge = new FutuTradeBridge({
    daemonScript: resolve(process.cwd(), "scripts/futu_trade_daemon.py"),
    host, port, env, market: "HK", unlockPwdMd5,
    onLog: (l) => process.stderr.write(`${l}\n`),
  });

  console.log(`==== HK Flatten (${env}) ====`);
  await bridge.start();

  const positions = await bridge.getPositions();
  const sellable = positions
    .filter((p) => p.canSellQty > 0)
    .filter((p) => !only || only.has(p.symbol));

  if (sellable.length === 0) {
    console.log("无可卖持仓.");
    await bridge.stop();
    return;
  }

  console.log("即将市价卖出:");
  for (const p of sellable) {
    console.log(`  - ${p.symbol} ${p.name}  qty=${p.qty} canSell=${p.canSellQty}  cost=${p.costPrice} now=${p.currentPrice}  pnl=${p.plVal.toFixed(2)} (${(p.plRatio).toFixed(2)}%)`);
  }

  if (env === "REAL") {
    console.log("⚠️  REAL 模式不允许 --auto, 必须手动 yes 确认.");
    if (auto) { await bridge.stop(); process.exit(2); }
  }

  if (!auto) {
    const ans = await ask("输入 'yes' 继续, 其它退出: ");
    if (ans.toLowerCase() !== "yes") {
      console.log("已取消.");
      await bridge.stop();
      return;
    }
  } else {
    console.log("[--auto] 自动确认.");
  }

  for (const p of sellable) {
    const shares = Math.floor(p.canSellQty);
    if (shares <= 0) continue;
    try {
      const r = await bridge.submitMarketSell(p.symbol, shares);
      console.log(`  ✓ SELL ${p.symbol} x${shares}  order=${r.orderId}  filled=${r.filledPrice}`);
    } catch (e) {
      console.error(`  ✗ SELL ${p.symbol} x${shares} failed:`, e instanceof Error ? e.message : e);
    }
  }

  // 复查
  await new Promise((r) => setTimeout(r, 2000));
  const after = await bridge.getPositions();
  console.log("\n剩余持仓:");
  if (after.length === 0) console.log("  (空)");
  else for (const p of after) console.log(`  - ${p.symbol} qty=${p.qty} canSell=${p.canSellQty}`);

  await bridge.stop();
}

main().catch((e) => {
  console.error("flatten failed:", e);
  process.exit(1);
});
