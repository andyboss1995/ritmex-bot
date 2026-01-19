import { pathToFileURL } from "url";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { TDG } from "@grvt/client";
import { HttpsProxyAgent } from "https-proxy-agent";
import axios from "axios";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const bot1EnvPath = path.resolve(__dirname, "../deploy/bot1/.env.grvt");
const bot2EnvPath = path.resolve(__dirname, "../deploy/bot2/.env.grvt");

async function checkKey(name: string, env: Record<string, string>) {
    console.log(`\n🔍 Checking [${name}]...`);

    const apiKey = env.GRVT_API_KEY;
    const apiSecret = env.GRVT_API_SECRET;
    const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;

    if (!apiKey) {
        console.log("❌ No API Key found.");
        return;
    }

    let axiosConfig = {};
    if (proxy) {
        console.log(`   Using Proxy: ${proxy}`);
        const agent = new HttpsProxyAgent(proxy);
        axiosConfig = { httpsAgent: agent, proxy: false };
        axios.defaults.httpsAgent = agent;
        axios.defaults.proxy = false;
    }

    try {
        const tdg: any = new TDG({
            host: "https://trades.grvt.io",
            axiosConfig
        });

        // DEBUG: Print keys to find where 'auth' is
        console.log("   TDG keys:", Object.keys(tdg));
        // Check prototype for methods
        console.log("   TDG proto keys:", Object.getOwnPropertyNames(Object.getPrototypeOf(tdg)));

        let loginRes;

        if (tdg.auth && typeof tdg.auth.login === 'function') {
            console.log("   Attempting tdg.auth.login...");
            loginRes = await tdg.auth.login(apiKey, apiSecret);
        } else if (typeof tdg.login === 'function') {
            console.log("   Attempting tdg.login...");
            loginRes = await tdg.login(apiKey, apiSecret);
        } else {
            // Maybe it's not instantiated correctly or structure is deep
            console.log("   ⚠️ Cannot find login method. Trying to infer structure.");
            if (tdg.authService) {
                console.log("   Found authService, trying login...");
                loginRes = await tdg.authService.login(apiKey, apiSecret);
            } else {
                throw new Error("Login functionality missing on TDG object");
            }
        }

        if (loginRes) {
            console.log("   ✅ Login Success!");
            // Extract Main Account ID
            // The response structure might vary
            const accId = (loginRes as any).account_id || (loginRes as any).accountId;
            console.log("   Account ID (Main):", accId);

            // Now try to fetch Subaccounts
            // Assuming we have a way...
            // Checking if 'subAccount' service exists
            if (tdg.subAccount && tdg.subAccount.list) {
                console.log("   Fetching Subaccounts...");
                const subs = await tdg.subAccount.list();
                console.log("   Subaccounts:", JSON.stringify(subs, null, 2));
            } else {
                console.log("   ⚠️ tdg.subAccount.list not found. Please log the TDG structure above to help debugging.");
            }
        }

    } catch (e: any) {
        console.log("❌ Error during check:");
        if (axios.isAxiosError(e)) {
            console.log("   Status:", e.response?.status);
            console.log("   Data:", JSON.stringify(e.response?.data));
        } else {
            console.log("   Message:", e.message);
            console.log("   Stack:", e.stack);
        }
    }
}

async function main() {
    console.log("========================================");
    console.log("      GRVT Account & Key Checker        ");
    console.log("========================================");

    const env1 = parseEnv(bot1EnvPath);
    await checkKey("Bot 1", env1);

    const env2 = parseEnv(bot2EnvPath);
    await checkKey("Bot 2", env2);

    console.log("\n========================================");
}

main();
