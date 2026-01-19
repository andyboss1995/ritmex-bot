import { GrvtExchangeAdapter } from "../src/exchanges/grvt/adapter";
import type { AsterAccountSnapshot } from "../src/exchanges/types";
import path from "path";
import fs from "fs";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env files for both bots
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

async function fetchAccountState(name: string, env: Record<string, string>) {
    if (!env.GRVT_API_KEY) {
        console.log(`[${name}] No API Key found.`);
        return null;
    }

    const adapter = new GrvtExchangeAdapter({
        apiKey: env.GRVT_API_KEY,
        apiSecret: env.GRVT_API_SECRET,
        subAccountId: env.GRVT_SUB_ACCOUNT_ID,
        instrument: env.GRVT_INSTRUMENT,
        env: (env.GRVT_ENV as any) || "prod",
    });

    console.log(`[${name}] Fetching baseline data...`);

    const snapshot = await new Promise<AsterAccountSnapshot>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout")), 10000);
        adapter.watchAccount((data) => {
            clearTimeout(timeout);
            resolve(data);
        });
    }).catch(err => {
        console.error(`[${name}] Error: ${err.message}`);
        return null;
    });

    if (!snapshot) return null;

    return {
        walletBalance: Number(snapshot.totalWalletBalance ?? 0),
        equity: Number(snapshot.totalMarginBalance ?? 0),
        timestamp: Date.now()
    };
}

async function main() {
    console.log("Creating Baseline Snapshot for PnL Tracking...");

    // Ensure data dir exists
    const dataDir = path.dirname(snapshotPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const env1 = parseEnv(bot1EnvPath);
    const env2 = parseEnv(bot2EnvPath);

    const results = await Promise.allSettled([
        fetchAccountState("Bot 1", env1),
        fetchAccountState("Bot 2", env2)
    ]);

    const state1 = results[0].status === "fulfilled" ? results[0].value : null;
    const state2 = results[1].status === "fulfilled" ? results[1].value : null;

    if (!state1) console.log("⚠️ Bot 1 failed to initialize.");
    if (!state2) console.log("⚠️ Bot 2 failed to initialize.");

    if (!state1 && !state2) {
        console.error("❌ Both bots failed. Cannot save baseline.");
        process.exit(1);
    }

    const baseline = {
        bot1: state1,
        bot2: state2,
        createdAt: new Date().toISOString()
    };

    fs.writeFileSync(snapshotPath, JSON.stringify(baseline, null, 2));
    console.log("---------------------------------------");
    console.log(`✅ Baseline saved to: ${snapshotPath}`);
    if (state1) console.log(`Bot 1 Initial Equity: $${state1.equity.toFixed(2)}`);
    if (state2) console.log(`Bot 2 Initial Equity: $${state2.equity.toFixed(2)}`);
    console.log("---------------------------------------");
    console.log("Reports will now calculate PnL relative to these values.");
    process.exit(0);
}

main();
