import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { MDG } from "@grvt/client";
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

async function checkInstrument() {
    console.log("🔍 Checking Instrument Limits for BTC_USDT_Perp...");

    // Load config just for proxy
    const env = parseEnv(bot1EnvPath);
    const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;

    let axiosConfig = {};
    if (proxy) {
        console.log(`   Using Proxy: ${proxy}`);
        const agent = new HttpsProxyAgent(proxy);
        axiosConfig = { httpsAgent: agent, proxy: false };
        axios.defaults.httpsAgent = agent;
        axios.defaults.proxy = false;
    }

    try {
        console.log("   Initializing MDG...");
        const mdg = new MDG({
            host: "https://market.grvt.io",
            axiosConfig
        });

        const instrument = "BTC_USDT_Perp";
        console.log(`   Fetching info for: ${instrument}...`);
        const info = await mdg.instrument({ instrument });

        console.log("   ✅ Received Info!");
        // Print to console for immediate visibility
        const json = JSON.stringify(info, null, 2);
        console.log(json);

        // Also save to root debug file
        const outPath = path.resolve(__dirname, "../instrument_debug.json");
        fs.writeFileSync(outPath, json);
        console.log(`   Saved to ${outPath}`);

    } catch (e: any) {
        console.log("❌ Error fetching instrument:");
        if (axios.isAxiosError(e)) {
            console.log("   Status:", e.response?.status);
            console.log("   Data:", JSON.stringify(e.response?.data));
        } else {
            console.log("   Error:", e.message);
            console.log("   Stack:", e.stack);
        }
    }
}

checkInstrument();
