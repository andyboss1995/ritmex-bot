import React from "react";
import { render } from "ink";
import { setupGlobalErrorHandlers } from "./runtime-errors";
import { parseCliArgs, printCliHelp } from "./cli/args";
import dotenv from "dotenv";
import path from "path";

// 1. Setup Errors & Parse Args immediately
setupGlobalErrorHandlers();
const options = parseCliArgs();

// 2. Load Env (CRITICAL: Must happen before importing config-dependent modules)
if (options.envFile) {
  const envPath = path.resolve(process.cwd(), options.envFile);
  dotenv.config({ path: envPath, override: true });
  console.log(`[Init] Loaded environment from: ${envPath}`);
}

// 3. Dynamic Imports
// These modules read process.env at top-level, so we import them only AFTER dotenv.config
const { App } = await import("./ui/App");
const { startStrategy } = await import("./cli/strategy-runner");

// If user specifies --exchange, override environment-based resolution for this process
if (options.exchange) {
  process.env.EXCHANGE = options.exchange;
  process.env.TRADE_EXCHANGE = options.exchange;
}

// 4. Main Logic
if (options.help) {
  printCliHelp();
  process.exit(0);
}

if (options.strategy) {
  startStrategy(options.strategy, { silent: options.silent })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Strategy] Failed to start: ${message}`);
      process.exit(1);
    });
} else {
  render(<App />);
}
