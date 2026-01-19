import { basisConfig, gridConfig, hedgingConfig, isBasisStrategyEnabled, liquidityMakerConfig, makerConfig, makerPointsConfig, tradingConfig } from "../config";
import { getExchangeDisplayName, resolveExchangeId } from "../exchanges/create-adapter";
import type { ExchangeAdapter } from "../exchanges/adapter";
import { buildAdapterFromEnv } from "../exchanges/resolve-from-env";
import { MakerEngine, type MakerEngineSnapshot } from "../strategy/maker-engine";
import { OffsetMakerEngine, type OffsetMakerEngineSnapshot } from "../strategy/offset-maker-engine";
import { LiquidityMakerEngine, type LiquidityMakerEngineSnapshot } from "../strategy/liquidity-maker-engine";
import { MakerPointsEngine, type MakerPointsSnapshot } from "../strategy/maker-points-engine";
import { TrendEngine, type TrendEngineSnapshot } from "../strategy/trend-engine";
import { GuardianEngine, type GuardianEngineSnapshot } from "../strategy/guardian-engine";
import { BasisArbEngine, type BasisArbSnapshot } from "../strategy/basis-arb-engine";
import { GridEngine, type GridEngineSnapshot } from "../strategy/grid-engine";
import { HedgingEngine, type HedgingSnapshot } from "../strategy/HedgingEngineV2";

import { extractMessage } from "../utils/errors";
import type { StrategyId } from "./args";
import fs from "fs";
import path from "path";

interface RunnerOptions {
  silent?: boolean;
}

type StrategyRunner = (options: RunnerOptions) => Promise<void>;

export const STRATEGY_LABELS: Record<StrategyId, string> = {
  trend: "Trend Following",
  guardian: "Guardian",
  maker: "Maker",
  "maker-points": "Maker Points",
  "offset-maker": "Offset Maker",
  "liquidity-maker": "Liquidity Maker",
  basis: "Basis Arbitrage",
  grid: "Grid",
  hedging: "Hedging",
};

export async function startStrategy(strategyId: StrategyId, options: RunnerOptions = {}): Promise<void> {
  const runner = STRATEGY_FACTORIES[strategyId];
  if (!runner) {
    throw new Error(`Unsupported strategy: ${strategyId}`);
  }
  await runner(options);
}

const STRATEGY_FACTORIES: Record<StrategyId, StrategyRunner> = {
  trend: async (opts) => {
    const config = tradingConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new TrendEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "trend",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  guardian: async (opts) => {
    const config = tradingConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new GuardianEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "guardian",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  maker: async (opts) => {
    const config = makerConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new MakerEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "maker",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  "maker-points": async (opts) => {
    const exchangeId = resolveExchangeId();
    if (exchangeId !== "standx") {
      throw new Error("Maker Points strategy only supports the StandX exchange.");
    }
    const config = makerPointsConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new MakerPointsEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "maker-points",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  "offset-maker": async (opts) => {
    const config = makerConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new OffsetMakerEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "offset-maker",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  "liquidity-maker": async (opts) => {
    const config = liquidityMakerConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new LiquidityMakerEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "liquidity-maker",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  basis: async (opts) => {
    if (!isBasisStrategyEnabled()) {
      throw new Error("Basis arbitrage strategy is disabled. Set ENABLE_BASIS_STRATEGY=true to enable it.");
    }
    const exchangeId = resolveExchangeId();
    if (exchangeId !== "aster" && exchangeId !== "nado" && exchangeId !== "standx") {
      throw new Error("Basis arbitrage strategy currently only supports the Aster, Nado, and StandX exchanges");
    }
    const adapter = createAdapterOrThrow(basisConfig.futuresSymbol);
    const engine = new BasisArbEngine(basisConfig, adapter);
    await runEngine({
      engine,
      strategy: "basis",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  grid: async (opts) => {
    const config = gridConfig;
    const adapter = createAdapterOrThrow(config.symbol);
    const engine = new GridEngine(config, adapter);
    await runEngine({
      engine,
      strategy: "grid",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  },
  hedging: async (opts) => {
    const config = hedgingConfig;

    // Helper to map Symbol (BTC-PERP) to GRVT Instrument (BTC_USDT_Perp)
    const toInstrument = (s: string) => {
      if (s.includes("_USDT_Perp")) return s;
      if (s === "BTC-PERP") return "BTC_USDT_Perp";
      if (s === "ETH-PERP") return "ETH_USDT_Perp";
      return s.replace("-", "_").replace("PERP", "USDT_Perp");
    };

    const instrA = toInstrument(config.symbolA);
    const instrB = toInstrument(config.symbolB);

    // Account 1 (BTC & ETH)
    const adapter1A = buildAdapterFromEnv({
      exchangeId: resolveExchangeId(),
      symbol: config.symbolA,
      instrument: instrA
    });
    const adapter1B = buildAdapterFromEnv({
      exchangeId: resolveExchangeId(),
      symbol: config.symbolB,
      instrument: instrB
    });

    // Account 2 (BTC & ETH) - "ACC2_" prefix
    const adapter2A = buildAdapterFromEnv({
      exchangeId: resolveExchangeId(),
      symbol: config.symbolA,
      envPrefix: "ACC2_",
      instrument: instrA
    });
    const adapter2B = buildAdapterFromEnv({
      exchangeId: resolveExchangeId(),
      symbol: config.symbolB,
      envPrefix: "ACC2_",
      instrument: instrB
    });

    const engine = new HedgingEngine(config, adapter1A, adapter1B, adapter2A, adapter2B);
    await runEngine({
      engine,
      strategy: "hedging",
      silent: opts.silent,
      getSnapshot: () => engine.getSnapshot(),
      onUpdate: (emitter) => engine.on("update", emitter),
      offUpdate: (emitter) => engine.off("update", emitter),
    });
  }

};

interface EngineHarness<TSnapshot> {
  engine: { start(): void; stop(): void };
  strategy: StrategyId;
  silent?: boolean;
  getSnapshot: () => TSnapshot;
  onUpdate: (handler: (snapshot: TSnapshot) => void) => void;
  offUpdate: (handler: (snapshot: TSnapshot) => void) => void;
}

async function runEngine<
  TSnapshot extends
  | TrendEngineSnapshot
  | GuardianEngineSnapshot
  | MakerEngineSnapshot
  | MakerPointsSnapshot
  | OffsetMakerEngineSnapshot
  | LiquidityMakerEngineSnapshot
  | BasisArbSnapshot
  | GridEngineSnapshot
  | HedgingSnapshot
>(
  harness: EngineHarness<TSnapshot>
): Promise<void> {
  const { engine, strategy, silent, getSnapshot, onUpdate, offUpdate } = harness;
  const exchangeId = resolveExchangeId();
  const exchangeName = getExchangeDisplayName(exchangeId);
  const label = STRATEGY_LABELS[strategy];

  const initial = getSnapshot();
  let lastLogKey: string | undefined;
  if (Array.isArray(initial.tradeLog) && initial.tradeLog.length > 0) {
    const lastEntry = initial.tradeLog[initial.tradeLog.length - 1]!;
    lastLogKey = createLogKey(lastEntry);
  }
  let readyLogged = initial.ready === true;

  /* --- FILE STATUS REPORTING --- */
  const PROJECT_ROOT = process.cwd();
  const DATA_DIR = path.join(PROJECT_ROOT, "data");
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const botName = process.env.name || `bot_${process.pid}`;
  const statusPath = path.join(DATA_DIR, `${botName}.status.json`);
  let lastWrite = 0;

  const emitter = (snapshot: TSnapshot) => {
    // 1. Log to Console
    if (Array.isArray(snapshot.tradeLog)) {
      if (!readyLogged && snapshot.ready) {
        readyLogged = true;
        console.info(`[${label}] Strategy ready. Listening for market data…`);
      }
      const pending = diffTradeLog(snapshot.tradeLog, lastLogKey);
      if (pending.length) {
        for (const entry of pending) {
          console.info(`[${label}] [${entry.time}] [${entry.type}] ${entry.detail}`);
        }
        const lastEntry = pending[pending.length - 1]!;
        if (lastEntry) {
          lastLogKey = createLogKey(lastEntry);
        }
      }
    }

    // 2. Write to File (Throttled 2s)
    const now = Date.now();
    if (now - lastWrite > 2000) {
      lastWrite = now;
      // Extract generic fields
      const anySnap = snapshot as any;
      // Try to find account info
      let balance = "0";
      let upnl = "0";
      let positions = 0;

      // GridEngine
      if (anySnap.position) {
        upnl = anySnap.position.unrealizedProfit || "0";
        if (anySnap.walletBalance) {
          balance = anySnap.walletBalance;
        }
      } else if (anySnap.account) {
        // Maker / Trend
        balance = anySnap.account.totalWalletBalance || "0";
        upnl = anySnap.account.totalUnrealizedProfit || "0";
      } else if (anySnap.acc1) {
        // Hedging: Aggregate?
        const b1 = Number(anySnap.acc1.walletBalance ?? 0);
        const b2 = Number(anySnap.acc2.walletBalance ?? 0);
        // We lack walletBalance on snapshot currently, so 0 default
        const u1 = anySnap.acc1.unrealized;
        const u2 = anySnap.acc2.unrealized;
        upnl = (u1 + u2).toFixed(4);
      }

      // We need to fix GridEngine to expose balance if we want it.
      // For now, write whatever we have.
      const statusPayload = {
        name: botName,
        strategy: label,
        updated: now,
        balance,
        upnl,
        // If GridEngine doesn't expose totalWalletBalance, we might need a quick fix in GridEngine too.
        // Assume we'll fix GridEngine next.
        snapshot: anySnap
      };
      fs.writeFileSync(statusPath, JSON.stringify(statusPayload));
    }
  };

  onUpdate(emitter);
  engine.start();

  console.info(`[${label}] Starting on ${exchangeName}. Mode: ${silent ? "silent" : "interactive"}. Press Ctrl+C to exit.`);

  const shutdown = (signal: NodeJS.Signals) => {
    try {
      console.info(`[${label}] Received ${signal}. Shutting down…`);
      engine.stop();
      offUpdate(emitter);
    } catch (error) {
      console.error(`[${label}] Error during shutdown: ${extractMessage(error)}`);
    }
  };

  await new Promise<void>((resolve) => {
    const wrapper = (signal: NodeJS.Signals) => {
      shutdown(signal);
      process.off("SIGINT", wrapper);
      process.off("SIGTERM", wrapper);
      resolve();
    };

    process.on("SIGINT", wrapper);
    process.on("SIGTERM", wrapper);
  });
}

function createAdapterOrThrow(symbol: string): ExchangeAdapter {
  return buildAdapterFromEnv({ exchangeId: resolveExchangeId(), symbol });
}

type TradeLogEntry = { time: string; type: string; detail: string };

function diffTradeLog(tradeLog: TradeLogEntry[], lastKey: string | undefined): TradeLogEntry[] {
  if (!tradeLog.length) return [];
  if (!lastKey) return tradeLog;
  const lastIndex = tradeLog.findIndex((entry) => createLogKey(entry) === lastKey);
  if (lastIndex === -1) {
    return tradeLog;
  }
  if (lastIndex === tradeLog.length - 1) return [];
  return tradeLog.slice(lastIndex + 1);
}

function createLogKey(entry: TradeLogEntry): string {
  return `${entry.time}|${entry.type}|${entry.detail}`;
}
