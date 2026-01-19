
import fs from "fs";
import path from "path";
import { type HedgingConfig } from "../config";
import type { ExchangeAdapter } from "../exchanges/adapter";
import type { AsterAccountSnapshot, AsterTicker, AsterOrder } from "../exchanges/types";
import { createTradeLog, type TradeLogEntry } from "../logging/trade-log";

import { StrategyEventEmitter } from "./common/event-emitter";
import { safeSubscribe, type LogHandler } from "./common/subscriptions";
import { t } from "../i18n";
import { getPosition, type PositionSnapshot } from "../utils/strategy";
import { extractMessage } from "../utils/errors";
import { createTelegramNotifier, type TelegramNotifier } from "../notifications/telegram";

export interface HedgingSnapshot {
    ready: boolean;
    status: "IDLE" | "OPENING" | "HOLDING" | "CLOSING" | "ERROR";
    nextActionTime: number;
    acc1: {
        unrealized: number;
        posA: PositionSnapshot; // BTC
        posB: PositionSnapshot; // ETH
    };
    acc2: {
        unrealized: number;
        posA: PositionSnapshot; // BTC
        posB: PositionSnapshot; // ETH
    };
    pnl: number;
    tradeLog: TradeLogEntry[];
    lastUpdated: number;
}

type HedgingEvent = "update";

interface HedgingState {
    lastOpenTime: number;
    lastCloseTime: number;
}

const STATE_FILE = path.resolve(process.cwd(), "data", "hedging-state.json");

export class HedgingEngine {
    private readonly tradeLog: ReturnType<typeof createTradeLog>;
    private readonly events = new StrategyEventEmitter<HedgingEvent, HedgingSnapshot>();
    private readonly telegram: TelegramNotifier;
    private timer: ReturnType<typeof setInterval> | null = null;
    private processing = false;

    // State
    private orderCache = new Map<string, AsterOrder>(); // ID -> Order

    private status: "IDLE" | "OPENING" | "HOLDING" | "CLOSING" | "ERROR" = "IDLE";
    private nextActionTime: number = 0;

    // Snapshots
    private acc1Snapshot: AsterAccountSnapshot | null = null;
    private acc2Snapshot: AsterAccountSnapshot | null = null;
    private tickerA: AsterTicker | null = null;
    private tickerB: AsterTicker | null = null;

    // Readiness
    private feedStatus = {
        acc1: false,
        acc2: false,
        tickerA: false,
        tickerB: false,
    };

    constructor(
        private readonly config: HedgingConfig,
        private readonly adapter1A: ExchangeAdapter, // Acc1 BTC
        private readonly adapter1B: ExchangeAdapter, // Acc1 ETH
        private readonly adapter2A: ExchangeAdapter, // Acc2 BTC
        private readonly adapter2B: ExchangeAdapter  // Acc2 ETH
    ) {
        this.tradeLog = createTradeLog(config.maxLogEntries);
        this.telegram = createTelegramNotifier();
        this.bootstrap();
        this.initializeTiming();
    }


    // --- Persistence ---
    private loadState(): HedgingState {
        try {
            if (fs.existsSync(STATE_FILE)) {
                return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
            }
        } catch (e) {
            console.error("Failed to load hedging state", e);
        }
        return { lastOpenTime: 0, lastCloseTime: 0 };
    }

    private saveState(state: Partial<HedgingState>): void {
        try {
            const current = this.loadState();
            const merged = { ...current, ...state };
            if (!fs.existsSync(path.dirname(STATE_FILE))) {
                fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
            }
            fs.writeFileSync(STATE_FILE, JSON.stringify(merged, null, 2));
        } catch (e) {
            console.error("Failed to save hedging state", e);
        }
    }

    private initializeTiming(): void {
        const state = this.loadState();
        const now = Date.now();
        const msSinceLast = now - state.lastOpenTime;

        // Safety: If run within INTERVAL of last run, force WAIT.
        if (msSinceLast < this.config.hedgeIntervalMs) {
            const remaining = this.config.hedgeIntervalMs - msSinceLast;
            this.nextActionTime = now + remaining;
            this.tradeLog.push("warn", `Safety: Recent run detected ${(msSinceLast / 60000).toFixed(1)}m ago. Waiting ${(remaining / 60000).toFixed(1)}m.`);
        } else {
            // First run (or long time ago): Start IMMEDIATELY
            this.nextActionTime = now + 5000; // 5s warmup
            this.tradeLog.push("info", "Ready: Will execute first trade in 5s.");
        }
    }

    start(): void {
        if (this.timer) return;
        this.tradeLog.push("info", t("log.hedging.start", { interval: this.config.hedgeIntervalMs / 1000 }));
        this.timer = setInterval(() => {
            void this.tick();
        }, 2000); // Check every 2 seconds

        // Start Data Feeds
        void this.bootstrap();


        // Notify start
        void this.telegram.send({
            type: "custom",
            level: "info",
            symbol: this.config.symbolA,
            title: "Hedging Strategy Started",
            message: `Engine initialized (LIMIT MID MODE). Interval: ${(this.config.hedgeIntervalMs / 60000).toFixed(1)}m`
        });
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.tradeLog.push("info", "Strategy stopped");
    }

    on(event: HedgingEvent, handler: (snapshot: HedgingSnapshot) => void): void {
        this.events.on(event, handler);
    }

    off(event: HedgingEvent, handler: (snapshot: HedgingSnapshot) => void): void {
        this.events.off(event, handler);
    }

    getSnapshot(): HedgingSnapshot {
        return this.buildSnapshot();
    }

    private async bootstrap(): Promise<void> {
        const log: LogHandler = (type, detail) => this.tradeLog.push(type, detail);

        // Helper to delay
        const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        // Adapter 1A (Acc1 BTC)
        safeSubscribe<AsterAccountSnapshot>(
            this.adapter1A.watchAccount.bind(this.adapter1A),
            (snap) => {
                this.acc1Snapshot = snap;
                this.feedStatus.acc1 = true;
                this.emitUpdate();
            },
            log,
            { subscribeFail: (e) => `Acc1 sub fail: ${e}`, processFail: (e) => `Acc1 proc fail: ${e}` }
        );
        await delay(2000); // 2s delay

        // Adapter 2A (Acc2 BTC)
        safeSubscribe<AsterAccountSnapshot>(
            this.adapter2A.watchAccount.bind(this.adapter2A),
            (snap) => {
                this.acc2Snapshot = snap;
                this.feedStatus.acc2 = true;
                this.emitUpdate();
            },
            log,
            { subscribeFail: (e) => `Acc2 sub fail: ${e}`, processFail: (e) => `Acc2 proc fail: ${e}` }
        );
        await delay(2000);

        // Tickers - Watch A on 1A, Watch B on 1B
        safeSubscribe<AsterTicker>(
            this.adapter1A.watchTicker.bind(this.adapter1A, this.config.symbolA),
            (ticker) => {
                this.tickerA = ticker;
                this.feedStatus.tickerA = true;
            },
            log,
            { subscribeFail: (e) => `TickerA sub fail: ${e}`, processFail: (e) => `TickerA proc fail: ${e}` }
        );
        await delay(1000);

        safeSubscribe<AsterTicker>(
            this.adapter1B.watchTicker.bind(this.adapter1B, this.config.symbolB),
            (ticker) => {
                this.tickerB = ticker;
                this.feedStatus.tickerB = true;
            },
            log,
            { subscribeFail: (e) => `TickerB sub fail: ${e}`, processFail: (e) => `TickerB proc fail: ${e}` }
        );

        // Orders - Watch all
        const orderHandler = (orders: AsterOrder[]) => {
            for (const o of orders) {
                if (o.orderId) this.orderCache.set(String(o.orderId), o);
            }
        };

        safeSubscribe(this.adapter1A.watchOrders.bind(this.adapter1A), orderHandler, log, { subscribeFail: (e) => `Ord1A fail:${e}`, processFail: (e) => `Ord1A proc fail:${e}` });

        safeSubscribe(this.adapter2A.watchOrders.bind(this.adapter2A), orderHandler, log, { subscribeFail: (e) => `Ord2A fail:${e}`, processFail: (e) => `Ord2A proc fail:${e}` });
        safeSubscribe(this.adapter1B.watchOrders.bind(this.adapter1B), orderHandler, log, { subscribeFail: (e) => `Ord1B fail:${e}`, processFail: (e) => `Ord1B proc fail:${e}` });
        safeSubscribe(this.adapter2B.watchOrders.bind(this.adapter2B), orderHandler, log, { subscribeFail: (e) => `Ord2B fail:${e}`, processFail: (e) => `Ord2B proc fail:${e}` });


    }




    private isReady(): boolean {
        return (
            this.feedStatus.acc1 &&
            this.feedStatus.acc2 &&
            this.feedStatus.tickerA &&
            this.feedStatus.tickerB
        );
    }

    private async tick(): Promise<void> {
        // Debug Log to confirm tick is running
        if (Date.now() % 5000 < 2000) {
            // Log less frequently to avoid spam, but enough to see activity
            console.log(`[Hedging Debug] Tick running. Processing: ${this.processing}, Ready: ${this.isReady()}`);
        }

        if (this.processing) return;
        this.processing = true;

        try {
            if (!this.isReady()) {
                if (Date.now() % 5000 < 1000) { // Log every ~5s
                    this.tradeLog.push("info", `Waiting for feeds... A1:${this.feedStatus.acc1} A2:${this.feedStatus.acc2} T1:${this.feedStatus.tickerA} T2:${this.feedStatus.tickerB}`);
                }
                return;
            }


            await this.evaluateState();
            this.emitUpdate();
        } catch (e) {
            this.tradeLog.push("error", `Tick error: ${extractMessage(e)}`);
        } finally {
            this.processing = false;
        }
    }

    private async evaluateState(): Promise<void> {
        const now = Date.now();
        // Simple state machine: IDLE -> Wait for Timer -> OPENING -> HOLDING -> Wait for Timer -> CLOSING -> IDLE

        switch (this.status) {
            case "IDLE":
                if (now >= this.nextActionTime) {
                    this.tradeLog.push("info", "Timer triggered: Switching to OPENING");
                    this.status = "OPENING";
                    // Next action time will be set AFTER opening
                }
                break;

            case "OPENING":
                const opened = await this.executeOpen();
                if (opened) {
                    this.status = "HOLDING";
                    this.saveState({ lastOpenTime: now });
                    this.scheduleNextAction(now);
                } else {
                    // Stay in OPENING or Retry? Or go to IDLE?
                    // For now, go to IDLE but schedule retry soon (e.g. 1 min) instead of full interval.
                    this.tradeLog.push("warn", "Open sequence failed. Retrying in 1 min.");
                    this.status = "IDLE";
                    this.nextActionTime = now + 60000;
                }
                break;


            case "HOLDING":
                if (now >= this.nextActionTime) {
                    this.tradeLog.push("info", "Timer triggered: Switching to CLOSING");
                    this.status = "CLOSING";
                    // Next action set after close
                }
                break;

            case "CLOSING":
                await this.executeClose();
                this.status = "IDLE";
                this.saveState({ lastCloseTime: now });
                this.scheduleNextAction(now); // Schedule next OPEN
                break;
        }
    }

    private scheduleNextAction(now: number): void {
        const jitter = (Math.random() - 0.5) * 2 * this.config.hedgeIntervalJitterMs;
        const nextDelay = Math.max(60000, this.config.hedgeIntervalMs + jitter);
        this.nextActionTime = now + nextDelay;
        const mins = (nextDelay / 60000).toFixed(1);
        this.tradeLog.push("info", `Next action scheduled in ${mins} mins`);
    }

    // --- Phase 2: Direction Logic & Limit Mid Price ---

    private getHedgeDirection(symbol: string): number {
        // Check Acc1 Position (Primary)
        if (this.acc1Snapshot && this.acc1Snapshot.positions) {
            const pos = this.acc1Snapshot.positions.find(p => p.symbol === symbol);
            if (pos && Math.abs(Number(pos.positionAmt)) > 0.0001) {
                // If we are LONG, we want to ADD to LONG (1) or HEDGE (depends on strategy?)
                // Strategy says: "Follow Trend" -> If Long, go Long.
                // Or "Counter Trend" -> If Long, go Short.
                // The config says "HEDGE_DEFAULT_DIR=1" (Trend Following by default?)

                // Let's assume we want to match the existing position sign
                return Math.sign(Number(pos.positionAmt));
            }
        }
        return this.config.hedgeDefaultDir;
    }


    private async executeOpen(): Promise<boolean> {

        this.tradeLog.push("order", "Executing OPEN sequence (Limit Price Mode)...");

        // Detect Direction
        // Detect Direction
        // User Request: If A is Long, B should be Short. (Counter-directional on same account)
        const dirA = this.getHedgeDirection(this.config.symbolA);
        const dirB = -dirA;


        const sideA1 = dirA > 0 ? "BUY" : "SELL";
        const sideA2 = dirA > 0 ? "SELL" : "BUY";

        const sideB1 = dirB > 0 ? "BUY" : "SELL";
        const sideB2 = dirB > 0 ? "SELL" : "BUY";

        // Execute Pair A
        const successA = await this.executeAtomicPair(
            this.config.symbolA,
            this.config.tradeAmountA,
            sideA1,
            sideA2
        );

        // Execute Pair B
        const successB = await this.executeAtomicPair(
            this.config.symbolB,
            this.config.tradeAmountB,
            sideB1,
            sideB2
        );

        return successA && successB;
    }

    private async executeAtomicPair(symbol: string, amount: number, side1: "BUY" | "SELL", side2: "BUY" | "SELL"): Promise<boolean> {

        // Prepare correct adapters
        const isSymA = symbol === this.config.symbolA;
        const ad1 = isSymA ? this.adapter1A : this.adapter1B;
        const ad2 = isSymA ? this.adapter2A : this.adapter2B;

        // Calculate Mid Price
        const ticker = isSymA ? this.tickerA : this.tickerB;
        if (!ticker || !ticker.bidPrice || !ticker.askPrice) {
            this.tradeLog.push("error", `${symbol} incomplete ticker data. Skipping`);
            return false;
        }


        // Aggressive Limit (Takable) to avoid legging
        // Buy at Ask * 1.0005, Sell at Bid * 0.9995
        // Unique name to prevent collision
        const isMakerBuy = side1 === "BUY";

        const isBuy2 = side2 === "BUY";

        const price1 = isMakerBuy ? Number(ticker.askPrice) * 1.0005 : Number(ticker.bidPrice) * 0.9995;

        const price2 = isBuy2 ? Number(ticker.askPrice) * 1.0005 : Number(ticker.bidPrice) * 0.9995;

        // Round using helper (if available, else standard toFixed)
        // Note: we need access to tickSize here. Assuming fixed 1 for now or use toFixed(2)
        // Better: rely on adapter to round, or just send raw. GRVT usually takes nearest.

        this.tradeLog.push("order", `Opening ${symbol}: Aggressive Limit (Takable) | Acc1 ${side1} @ ${price1.toFixed(2)} | Acc2 ${side2} @ ${price2.toFixed(2)}`);

        // Maker-Taker Logic (Legged)
        // Leg 1: Market Maker Limit on Adapter 1 (Passive)
        // Leg 2: Taker Market on Adapter 2 (Aggressive)


        // Price for Maker: Mid Price? Or Best Bid/Ask? 
        // User wants "Maker Fee". This implies POST ONLY or Passive.
        // Best Bid (for Buy) or Best Ask (for Sell).
        const makerPrice = isMakerBuy ? Number(ticker.bidPrice) : Number(ticker.askPrice);


        this.tradeLog.push("order", `Leg1 (Maker): ${symbol} ${side1} @ ${makerPrice}`);

        // Submit Leg 1
        const order1 = await ad1.createOrder({
            symbol, side: side1, type: "LIMIT", price: makerPrice, quantity: amount
        });

        // Debug Log
        this.tradeLog.push("info", `Leg1 Placed. REST ID: ${order1.orderId} (Raw: ${JSON.stringify(order1)})`);


        // Wait for Fill (Max 30s) - Poll API every 1s
        const filled = await this.waitForFill(ad1, symbol, String(order1.orderId), 30000);


        if (filled) {
            this.tradeLog.push("success", `Leg1 Filled! Executing Leg2 (Taker)...`);
            // Execute Leg 2: Market Order (or Aggressive Limit)
            // Using Aggressive Limit to ensure fill but avoid drift
            const isTakerBuy = side2 === "BUY";
            const takerPrice = isTakerBuy ? Number(ticker.askPrice) * 1.05 : Number(ticker.bidPrice) * 0.95;


            await ad2.createOrder({
                symbol, side: side2, type: "LIMIT", price: takerPrice, quantity: amount
            });

            this.tradeLog.push("success", `Leg2 Executed.`);

            void this.telegram.send({
                type: "position_opened",
                level: "success",
                title: "Hedge Executed (Maker-Taker)",
                symbol,
                message: `Maker Fill @ ${makerPrice} | Taker Executed`
            });
            return true;

        } else {
            // Timeout - Cancel Leg 1
            this.tradeLog.push("warn", `Leg1 Timeout. Attempting Cancel ${order1.orderId}`);
            let cancelSuccess = false;
            try {
                await ad1.cancelOrder({ symbol, orderId: order1.orderId! });
                cancelSuccess = true;
            } catch (e: any) {
                this.tradeLog.push("warn", `Cancel failed (might be filled?): ${e.message}`);

                // CRITICAL FIX: Check if it's filled!
                try {
                    const statusCheck = await ad1.getOrder(symbol, String(order1.orderId));
                    if (statusCheck && (statusCheck.status === 'FILLED' || statusCheck.status === 'CLOSED')) {
                        this.tradeLog.push("success", `Recovered Fill from Cancel Failure! Status: ${statusCheck.status}`);
                        // Jump to Leg 2 execution
                        // Fall out of else? No, duplicate code or refactor.
                        // Let's execute inline to be safe.

                        this.tradeLog.push("success", `Leg1 Verified Filled. Executing Leg2 (Taker)...`);
                        const isTakerBuy = side2 === "BUY";
                        const takerPrice = isTakerBuy ? Number(ticker.askPrice) * 1.05 : Number(ticker.bidPrice) * 0.95;

                        await ad2.createOrder({
                            symbol, side: side2, type: "LIMIT", price: takerPrice, quantity: amount
                        });

                        this.tradeLog.push("success", `Leg2 Executed (Recovered).`);
                        void this.telegram.send({
                            type: "position_opened",
                            level: "success",
                            title: "Hedge Executed (Recovered)",
                            symbol,
                            message: `Maker Fill @ ${makerPrice} | Taker Executed`
                        });
                        return true;
                    } else if (statusCheck) {
                        // Order is found but NOT filled (i.e. PENDING/OPEN)
                        // This is a Zombie Order! We MUST cancel it or Stop.
                        this.tradeLog.push("error", `Leg1 Cancel Failed AND Order is OPEN. Retrying Cancel...`);
                        try {
                            await ad1.cancelOrder({ symbol, orderId: order1.orderId! });
                            this.tradeLog.push("success", "Retry Cancel Successful.");
                        } catch (e2: any) {
                            this.tradeLog.push("fatal", `Zombie Order ${order1.orderId} could not be cancelled! Stopping strategy.`);
                            this.stop(); // CRITICAL: Stop the loop!
                            throw new Error(`Zombie Order ${order1.orderId} persists! Manually close it.`);
                        }
                    }
                } catch (err2) {
                    this.tradeLog.push("error", `Double failure checking status: ${err2}`);
                }
            }
            return false;
        }

    }

    private waitForFill(adapter: ExchangeAdapter, symbol: string, orderId: string, timeoutMs: number): Promise<boolean> {
        // Hybrid Approach: Check Cache (Fast) + Poll API (Reliable)
        return new Promise<boolean>((resolve) => {
            const start = Date.now();
            const pollInterval = 1000; // Poll API every 1s

            const check = async () => {
                try {
                    // 1. Check Local Cache (Fastest) - Updated by WS
                    let order = this.orderCache.get(orderId);
                    if (order && (order.status === "FILLED" || order.status === "CLOSED")) {
                        resolve(true);
                        return;
                    }
                    if (order && (order.status === "CANCELED" || order.status === "REJECTED")) {
                        resolve(false);
                        return;
                    }

                    // 2. Poll API (Reliable Fallback)
                    // Only poll if enough time passed to avoid rate limit spam (though 1s is fine)
                    if (Date.now() - start > 1000) { // Give WS 1s head start
                        const apiOrder = await adapter.getOrder(symbol, orderId);
                        if (apiOrder) {
                            // Update Cache
                            this.orderCache.set(orderId, apiOrder);
                            order = apiOrder; // Use the fresh data
                            if (order.status === "FILLED" || order.status === "CLOSED") {
                                this.tradeLog.push("info", "Detected Fill via API Polling");
                                resolve(true);
                                return;
                            }
                            if (order.status === "CANCELED" || order.status === "REJECTED") {
                                resolve(false);
                                return;
                            }
                        }
                    }

                    // Timeout Check
                    if (Date.now() - start > timeoutMs) {
                        resolve(false);
                        return;
                    }

                    setTimeout(check, pollInterval);
                } catch (e: any) {
                    console.error("waitForFill poll error", e);
                    // Continue polling
                    setTimeout(check, pollInterval);
                }
            };
            check();
        });
    }

    private async executeClose(): Promise<void> {
        this.tradeLog.push("order", "Executing CLOSE sequence...");
        // Close Pair A
        await this.closePair(this.config.symbolA, this.config.tradeAmountA);
        // Close Pair B
        await this.closePair(this.config.symbolB, this.config.tradeAmountB);
    }

    private async closePair(symbol: string, amount: number): Promise<void> {
        if (!this.acc1Snapshot || !this.acc2Snapshot) return;

        const pos1 = getPosition(this.acc1Snapshot, symbol).positionAmt;
        const pos2 = getPosition(this.acc2Snapshot, symbol).positionAmt;

        const side1 = pos1 > 0 ? "SELL" : "BUY";
        const side2 = pos2 > 0 ? "SELL" : "BUY";

        this.tradeLog.push("order", `Closing ${amount} ${symbol} (Market).`);

        // Using Market for closing ensures we get out.
        // Determine adapters
        const isSymA = symbol === this.config.symbolA;
        const ad1 = isSymA ? this.adapter1A : this.adapter1B;
        const ad2 = isSymA ? this.adapter2A : this.adapter2B;

        const p1 = ad1.createOrder({
            symbol, side: side1, type: "MARKET", quantity: amount
        });
        const p2 = ad2.createOrder({
            symbol, side: side2, type: "MARKET", quantity: amount
        });


        await Promise.allSettled([p1, p2]);

        void this.telegram.send({
            type: "position_closed",
            level: "info",
            title: "Hedge Cycle Closed",
            symbol,
            message: `Closed ${amount} ${symbol}.`
        });
    }

    private getPositions() {
        if (!this.acc1Snapshot || !this.acc2Snapshot) return null;
        return {
            acc1PosA: getPosition(this.acc1Snapshot, this.config.symbolA).positionAmt,
            acc1PosB: getPosition(this.acc1Snapshot, this.config.symbolB).positionAmt,
            acc2PosA: getPosition(this.acc2Snapshot, this.config.symbolA).positionAmt,
            acc2PosB: getPosition(this.acc2Snapshot, this.config.symbolB).positionAmt,
        };
    }

    private buildSnapshot(): HedgingSnapshot {
        const pos1A = this.acc1Snapshot ? getPosition(this.acc1Snapshot, this.config.symbolA) : { positionAmt: 0 } as any;
        const pos1B = this.acc1Snapshot ? getPosition(this.acc1Snapshot, this.config.symbolB) : { positionAmt: 0 } as any;
        const pos2A = this.acc2Snapshot ? getPosition(this.acc2Snapshot, this.config.symbolA) : { positionAmt: 0 } as any;
        const pos2B = this.acc2Snapshot ? getPosition(this.acc2Snapshot, this.config.symbolB) : { positionAmt: 0 } as any;

        return {
            ready: this.isReady(),
            status: this.status,
            nextActionTime: this.nextActionTime,
            acc1: {
                unrealized: Number(this.acc1Snapshot?.totalUnrealizedProfit ?? 0),
                posA: pos1A,
                posB: pos1B
            },
            acc2: {
                unrealized: Number(this.acc2Snapshot?.totalUnrealizedProfit ?? 0),
                posA: pos2A,
                posB: pos2B
            },
            pnl: 0,
            tradeLog: this.tradeLog.all(),
            lastUpdated: Date.now()
        };
    }

    private emitUpdate(): void {
        this.events.emit("update", this.buildSnapshot());
    }
}
