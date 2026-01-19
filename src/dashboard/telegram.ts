
import TelegramBot from "node-telegram-bot-api";

export interface BotStatus {
    name: string;
    id: string;
    type: "GRVT" | "STANDX";
    balance: string;
    upnl: string;
    status: string; // "Online" | "Offline" | "Stale (Xs)"
    ago: number;
}

export type StatusProvider = () => Promise<BotStatus[]>;

let bot: TelegramBot | null = null;
let provider: StatusProvider | null = null;
let chatId: string | null = null;
let monitorInterval: NodeJS.Timer | null = null;

// Track previous states for alert logic
const lastStates: Record<string, string> = {}; // id -> status
const lastAlertTime: Record<string, number> = {}; // id -> timestamp

// Config
const REPORT_INTERVAL_MS = 60 * 60 * 1000; // 1 Hour
const ALERT_COOLDOWN_MS = 15 * 60 * 1000; // 15 Min alert suppression

export function initTelegram(token: string, targetChatId: string, statusProvider: StatusProvider) {
    if (bot) return; // Already initialized

    console.log(`[Telegram] Initializing bot with Chat ID: ${targetChatId}`);

    bot = new TelegramBot(token, { polling: true });
    chatId = targetChatId;
    provider = statusProvider;

    // Command: /status
    bot.onText(/\/status/, async (msg) => {
        if (!provider || String(msg.chat.id) !== chatId) return;

        const statuses = await provider();
        const response = formatStatusMessage(statuses);
        bot!.sendMessage(chatId!, response, { parse_mode: "Markdown" });
    });

    // Handle Polling Errors
    bot.on("polling_error", (error) => {
        console.error(`[Telegram] Polling Error: ${error.code} - ${error.message}`);
    });

    // Start Monitoring Loop
    startMonitoring();

    // Send hello message
    bot.sendMessage(chatId, "🚀 **Ritmex Bot Monitoring Started**\nType `/status` to check system health.", { parse_mode: "Markdown" });
}

function startMonitoring() {
    if (monitorInterval) clearInterval(monitorInterval);

    // Check every 1 minute
    monitorInterval = setInterval(async () => {
        if (!provider || !bot || !chatId) return;

        const statuses = await provider();
        const now = Date.now();

        for (const s of statuses) {
            const prevStatus = lastStates[s.id] || "Online";

            // 1. Detect Offline Transition
            if (s.status === "Offline" && prevStatus !== "Offline") {
                // Check cooldown
                if (!lastAlertTime[s.id] || (now - lastAlertTime[s.id] > ALERT_COOLDOWN_MS)) {
                    const msg = `🚨 **ALERT: Bot Offline**\n\n**${s.name}** is not reporting data!\nLast Update: ${s.ago}s ago.`;
                    bot.sendMessage(chatId, msg, { parse_mode: "Markdown" });
                    lastAlertTime[s.id] = now;
                }
            }

            lastStates[s.id] = s.status;
        }

    }, 60 * 1000);

    // TODO: Periodic summary report logic can go here (e.g. check current hour)
}

function formatStatusMessage(statuses: BotStatus[]): string {
    const lines = ["📊 **System Status**\n"];

    for (const s of statuses) {
        const icon = s.status === "Online" ? "🟢" : "🔴";
        lines.push(`${icon} **${s.name}**`);
        lines.push(`   • Status: ${s.status}`);
        lines.push(`   • Balance: ${s.balance}`);
        lines.push(`   • uPnL: ${s.upnl}`);
        lines.push("");
    }

    lines.push(`_Updated: ${new Date().toLocaleTimeString()}_`);
    return lines.join("\n");
}
