import { serve } from "bun";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import dotenv from "dotenv";

// Import Gateways
import { GrvtGateway } from "../exchanges/grvt/gateway";
import { StandxGateway } from "../exchanges/standx/gateway";
import { privateKeyToAccount } from "viem/accounts";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../");

// Logger
const log = (ctx: string, msg: any) => console.log(`[Dashboard] [${ctx}]`, msg);

// Global Error Handlers (Prevent crash)
process.on("uncaughtException", (err) => {
    log("Fatal", `Uncaught Exception: ${err}`);
});
process.on("unhandledRejection", (reason, promise) => {
    log("Fatal", `Unhandled Rejection: ${reason}`);
});

// --- Configuration Helper ---
function loadEnv(path: string): Record<string, string> {
    if (!fs.existsSync(path)) return {};
    const content = fs.readFileSync(path, "utf-8");
    const parsed = dotenv.parse(content);
    // Inject into process.env so Gateways can see HTTPS_PROXY
    for (const [key, value] of Object.entries(parsed)) {
        process.env[key] = value;
    }
    return parsed;
}



// --- Bot Manager (File Based) ---
const DATA_DIR = join(PROJECT_ROOT, "data");

// Define expected bots (Static config for now, or dynamic scan)
const KNOWN_BOTS = [
    { id: "grvt-bot1-long", name: "GRVT Bot 1 (Long)", type: "GRVT" },
    { id: "grvt-bot2-short", name: "GRVT Bot 2 (Short)", type: "GRVT" },
    { id: "ritmex-maker-points", name: "StandX Main", type: "STANDX" }
];

async function getBotStatus() {
    const statusList = await Promise.all(KNOWN_BOTS.map(async (bot) => {
        const filePath = join(DATA_DIR, `${bot.id}.status.json`);
        let balance = "---";
        let upnl = "---";
        let updated = 0;
        let strategy = "";
        let symbol = "";
        let position: any = null;

        try {
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, "utf-8");
                const data = JSON.parse(content);
                balance = data.balance || "---";
                upnl = data.upnl || "---";
                updated = data.updated || 0;
                strategy = data.strategy || "";
                if (data.snapshot) {
                    if (data.snapshot.position) {
                        position = data.snapshot.position;
                    }
                    if (data.snapshot.symbol) {
                        symbol = data.snapshot.symbol;
                    }
                }
            }
        } catch (e) {
            // file read error or parsing error, ignore
        }

        // Format updated time
        const now = Date.now();
        const ago = updated ? Math.floor((now - updated) / 1000) : -1;
        let statusText = "Offline";
        if (ago !== -1 && ago < 60) statusText = "Online";
        else if (ago !== -1) statusText = `Stale (${ago}s)`;

        return {
            name: bot.name,
            id: bot.id, // PM2 ID or Name for control
            type: bot.type as "GRVT" | "STANDX",
            balance: typeof balance === 'number' ? (balance as number).toFixed(2) : balance,
            upnl: typeof upnl === 'number' ? (upnl as number).toFixed(2) : upnl,
            status: statusText,
            ago,
            position,
            symbol
        };
    }));



    return statusList;
}

// Export for Telegram module
export { getBotStatus };

// --- PM2 Helper ---
async function getPM2List() {
    try {
        const { stdout } = await execAsync("pm2 jlist");
        const processes = JSON.parse(stdout);
        return processes.map((p: any) => ({
            name: p.name,
            id: p.pm_id,
            status: p.pm2_env.status,
            memory: p.monit.memory,
            cpu: p.monit.cpu,
            uptime: p.pm2_env.pm_uptime
        }));
    } catch (e) {
        return [];
    }
}


// --- Server ---
const PORT = 3456;

serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);

        // API: Status
        if (url.pathname === "/api/status") {
            const processes = await getPM2List();
            const botBalances = await getBotStatus();
            return Response.json({ processes, bots: botBalances });
        }

        // API: Control
        if (url.pathname === "/api/control" && req.method === "POST") {
            const body = await req.json() as any;
            const { action, id } = body; // action: start|stop|restart, id: process_id or 'all'

            let cmd = "";
            if (id === "all") {
                if (action === "stop") cmd = "pm2 stop all";
                if (action === "restart") cmd = "pm2 restart all";
                if (action === "start") cmd = "pm2 resurrect"; // rough guess
            } else {
                cmd = `pm2 ${action} ${id}`;
            }

            try {
                await execAsync(cmd);
                return Response.json({ success: true });
            } catch (e) {
                return Response.json({ success: false, error: String(e) });
            }
        }

        // Frontend: Serve HTML
        if (url.pathname === "/" || url.pathname === "/index.html") {
            const htmlPath = join(__dirname, "public/index.html");
            const html = await Bun.file(htmlPath).text();
            return new Response(html, { headers: { "Content-Type": "text/html" } });
        }

        return new Response("Not Found", { status: 404 });
    },
});


// --- Telegram Integration ---
import { initTelegram, type BotStatus } from "./telegram";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    initTelegram(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, getBotStatus);
} else {
    console.log("[Dashboard] Telegram keys missing in .env, skipping notification module.");
}

console.log(`Dashboard running at http://localhost:${PORT}`);
