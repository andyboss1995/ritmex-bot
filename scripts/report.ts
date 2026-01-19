import { GrvtExchangeAdapter } from "../src/exchanges/grvt/adapter";
import type { AsterAccountSnapshot } from "../src/exchanges/types";
import path from "path";
import fs from "fs";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const bot1EnvPath = path.resolve(__dirname, "../deploy/bot1/.env.grvt");
const bot2EnvPath = path.resolve(__dirname, "../deploy/bot2/.env.grvt");
const snapshotPath = path.resolve(__dirname, "../data/pnl_baseline.json");

function parseEnv(filePath: string): Record<string, string> {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, "utf-8");
    const env: Record<string, string> = {};
    content.split("\n").forEach((line) => {
        const [key, ...values] = line.split("=");
        if (key && !key.startsWith("#")) {
            env[key.trim()] = values.join("=").trim();
        }
    });
    return env;
}

function loadBaseline() {
    if (!fs.existsSync(snapshotPath)) return null;
    return JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
}

async function getAccountPnL(name: string, env: Record<string, string>, baseline: any) {
    if (!env.GRVT_API_KEY) return null;

    const adapter = new GrvtExchangeAdapter({
        apiKey: env.GRVT_API_KEY,
        apiSecret: env.GRVT_API_SECRET,
        subAccountId: env.GRVT_SUB_ACCOUNT_ID,
        instrument: env.GRVT_INSTRUMENT,
        env: (env.GRVT_ENV as any) || "prod",
    });

    const snapshot = await new Promise<AsterAccountSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
        adapter.watchAccount((data) => {
            clearTimeout(timeout);
            resolve(data);
        });
    }).catch(() => null);

    if (!snapshot) return null;

    const currentEquity = Number(snapshot.totalMarginBalance ?? 0);
    const currentUnrealized = Number(snapshot.totalUnrealizedProfit ?? 0);

    // Logic: Total PnL = Current Equity - Baseline Equity
    // This captures Realized Profit (Wallet Balance increase) + Unrealized Profit change
    // Note: This assumes NO withdrawals/deposits were made since baseline.
    let totalPnL = 0;
    let roi = 0;

    if (baseline) {
        totalPnL = currentEquity - baseline.equity;
        if (baseline.equity > 0) {
            roi = (totalPnL / baseline.equity) * 100;
        }
    }

    return {
        name,
        equity: currentEquity,
        unrealized: currentUnrealized,
        totalPnL,
        roi,
        baselineEquity: baseline?.equity ?? 0
    };
}

async function main() {
    const baselineData = loadBaseline();

    console.log("=========================================");
    console.log("       GRVT Dual-Bot Performance         ");
    console.log("=========================================");
    console.log(`Time: ${new Date().toLocaleString()}`);

    if (!baselineData) {
        console.log("⚠️  NO BASELINE FOUND!");
        console.log("   Please run: npx tsx scripts/init_baseline.ts");
        console.log("   to set the starting point for PnL tracking.");
        console.log("=========================================");
        process.exit(0);
    }

    console.log(`Tracking since: ${new Date(baselineData.createdAt).toLocaleString()}`);
    console.log("-----------------------------------------");

    const env1 = parseEnv(bot1EnvPath);
    const env2 = parseEnv(bot2EnvPath);

    const [res1, res2] = await Promise.all([
        getAccountPnL("Bot 1 (Long)", env1, baselineData.bot1),
        getAccountPnL("Bot 2 (Short)", env2, baselineData.bot2)
    ]);

    if (res1) {
        console.log(`\n${res1.name}:`);
        console.log(`  Initial Equity:   $${res1.baselineEquity.toFixed(2)}`);
        console.log(`  Current Equity:   $${res1.equity.toFixed(2)}`);
        console.log(`  Floating PnL:     $${res1.unrealized.toFixed(2)}`);
        console.log(`  Total Net PnL:    $${res1.totalPnL.toFixed(2)}`);
        console.log(`  Strategy ROI:     ${res1.roi.toFixed(3)}%`);
    }

    if (res2) {
        console.log(`\n${res2.name}:`);
        console.log(`  Initial Equity:   $${res2.baselineEquity.toFixed(2)}`);
        console.log(`  Current Equity:   $${res2.equity.toFixed(2)}`);
        console.log(`  Floating PnL:     $${res2.unrealized.toFixed(2)}`);
        console.log(`  Total Net PnL:    $${res2.totalPnL.toFixed(2)}`);
        console.log(`  Strategy ROI:     ${res2.roi.toFixed(3)}%`);
    }

    if (res1 && res2) {
        console.log("\n-----------------------------------------");
        console.log("AGGREGATE REPORT:");
        const netPnL = res1.totalPnL + res2.totalPnL;
        const initialTotal = res1.baselineEquity + res2.baselineEquity;
        console.log(`  Total Initial:    $${initialTotal.toFixed(2)}`);
        console.log(`  Total Current:    $${(res1.equity + res2.equity).toFixed(2)}`);
        console.log(`  Net Profit:       $${netPnL.toFixed(2)}`);
        console.log(`  Combined ROI:     ${((netPnL / initialTotal) * 100).toFixed(3)}%`);
    }

    console.log("=========================================");
    process.exit(0);
}

main();
