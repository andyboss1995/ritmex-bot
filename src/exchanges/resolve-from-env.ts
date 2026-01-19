import type { ExchangeAdapter } from "./adapter";
import { createExchangeAdapter, resolveExchangeId, type SupportedExchangeId } from "./create-adapter";
import type { AsterCredentials } from "./aster-adapter";
import type { LighterCredentials } from "./lighter/adapter";
import type { BackpackCredentials } from "./backpack/adapter";
import type { ParadexCredentials } from "./paradex/adapter";
import type { NadoCredentials } from "./nado/adapter";
import type { StandxCredentials } from "./standx/adapter";
import { t } from "../i18n";
import type { Address } from "viem";

interface BuildAdapterOptions {
  symbol: string;
  exchangeId?: string | SupportedExchangeId;
  envPrefix?: string;
  instrument?: string;
}

import type { GrvtCredentials } from "./grvt/adapter";



export function buildAdapterFromEnv(options: BuildAdapterOptions): ExchangeAdapter {
  const id = resolveExchangeId(options.exchangeId);
  const symbol = options.symbol;
  const prefix = options.envPrefix;

  if (id === "aster") {
    const credentials = resolveAsterCredentials(prefix);
    return createExchangeAdapter({ exchange: id, symbol, aster: credentials });
  }

  if (id === "lighter") {
    const credentials = resolveLighterCredentials(symbol, prefix);
    return createExchangeAdapter({ exchange: id, symbol, lighter: credentials });
  }

  if (id === "backpack") {
    const credentials = resolveBackpackCredentials(symbol, prefix);
    return createExchangeAdapter({ exchange: id, symbol, backpack: credentials });
  }

  if (id === "paradex") {
    const credentials = resolveParadexCredentials(prefix);
    return createExchangeAdapter({ exchange: id, symbol, paradex: credentials });
  }

  if (id === "nado") {
    const credentials = resolveNadoCredentials(symbol, prefix);
    return createExchangeAdapter({ exchange: id, symbol, nado: credentials });
  }

  if (id === "standx") {
    const credentials = resolveStandxCredentials(symbol, prefix);
    return createExchangeAdapter({ exchange: id, symbol, standx: credentials });
  }

  if (id === "grvt") {
    const credentials = resolveGrvtCredentials(symbol, options.instrument, prefix);
    return createExchangeAdapter({ exchange: id, symbol, grvt: credentials });
  }

  return createExchangeAdapter({
    exchange: id,
    symbol,
    grvt: {
      symbol,
      instrument: options.instrument
    }
  });

}


function getEnv(key: string, prefix?: string): string | undefined {
  if (prefix) {
    const prefixedValue = process.env[`${prefix}${key}`];
    if (prefixedValue) return prefixedValue;
  }
  return process.env[key];
}

function resolveAsterCredentials(prefix?: string): AsterCredentials {
  const apiKey = getEnv("ASTER_API_KEY", prefix);
  const apiSecret = getEnv("ASTER_API_SECRET", prefix);
  if (!apiKey || !apiSecret) {
    throw new Error(t("env.missingAster"));
  }
  return { apiKey, apiSecret };
}

function resolveLighterCredentials(symbol: string, prefix?: string): LighterCredentials {
  const accountIndexRaw = getEnv("LIGHTER_ACCOUNT_INDEX", prefix);
  const apiPrivateKey = getEnv("LIGHTER_API_PRIVATE_KEY", prefix);
  if (!accountIndexRaw || !apiPrivateKey) {
    throw new Error(t("env.missingLighter"));
  }
  const accountIndex = Number(accountIndexRaw);
  if (!Number.isInteger(accountIndex)) {
    throw new Error(t("env.lighterIndexInteger"));
  }
  const credentials: LighterCredentials = {
    displaySymbol: symbol,
    accountIndex,
    apiPrivateKey,
    apiKeyIndex: getEnv("LIGHTER_API_KEY_INDEX", prefix) ? Number(getEnv("LIGHTER_API_KEY_INDEX", prefix)) : 0,
    environment: getEnv("LIGHTER_ENV", prefix),
    baseUrl: getEnv("LIGHTER_BASE_URL", prefix),
    l1Address: getEnv("LIGHTER_L1_ADDRESS", prefix),
    marketSymbol: getEnv("LIGHTER_SYMBOL", prefix),
    marketId: getEnv("LIGHTER_MARKET_ID", prefix) ? Number(getEnv("LIGHTER_MARKET_ID", prefix)) : undefined,
    priceDecimals: getEnv("LIGHTER_PRICE_DECIMALS", prefix) ? Number(getEnv("LIGHTER_PRICE_DECIMALS", prefix)) : undefined,
    sizeDecimals: getEnv("LIGHTER_SIZE_DECIMALS", prefix) ? Number(getEnv("LIGHTER_SIZE_DECIMALS", prefix)) : undefined,
  };
  return credentials;
}

function resolveBackpackCredentials(symbol: string, prefix?: string): BackpackCredentials {
  const apiKey = getEnv("BACKPACK_API_KEY", prefix);
  const apiSecret = getEnv("BACKPACK_API_SECRET", prefix);
  if (!apiKey || !apiSecret) {
    throw new Error(t("env.missingBackpack"));
  }
  const credentials: BackpackCredentials = {
    apiKey,
    apiSecret,
    password: getEnv("BACKPACK_PASSWORD", prefix),
    subaccount: getEnv("BACKPACK_SUBACCOUNT", prefix),
    symbol: getEnv("BACKPACK_SYMBOL", prefix) ?? symbol,
    sandbox: parseOptionalBoolean(getEnv("BACKPACK_SANDBOX", prefix)),
  };
  return credentials;
}

function resolveParadexCredentials(prefix?: string): ParadexCredentials {
  const privateKey = getEnv("PARADEX_PRIVATE_KEY", prefix);
  const walletAddress = getEnv("PARADEX_WALLET_ADDRESS", prefix);

  if (!privateKey || !walletAddress) {
    throw new Error(t("env.missingParadex"));
  }
  if (!isHex32(privateKey)) {
    throw new Error(t("env.invalidParadexPrivateKey"));
  }
  if (!isHexAddress(walletAddress)) {
    throw new Error(t("env.invalidParadexAddress"));
  }

  const credentials: ParadexCredentials = {
    privateKey,
    walletAddress,
    sandbox: parseOptionalBoolean(getEnv("PARADEX_SANDBOX", prefix)),
    usePro: parseOptionalBoolean(getEnv("PARADEX_USE_PRO", prefix)),
    watchReconnectDelayMs: parseOptionalNumber(getEnv("PARADEX_RECONNECT_DELAY_MS", prefix)),
  };

  return credentials;
}

function resolveNadoCredentials(symbol: string, prefix?: string): NadoCredentials {
  const signerPrivateKey = getEnv("NADO_SIGNER_PRIVATE_KEY", prefix);
  const subaccountOwner = getEnv("NADO_SUBACCOUNT_OWNER", prefix) ?? getEnv("NADO_EVM_ADDRESS", prefix);

  if (!signerPrivateKey || !subaccountOwner) {
    throw new Error(t("env.missingNado"));
  }
  if (!isHex32(signerPrivateKey)) {
    throw new Error(t("env.invalidNadoPrivateKey"));
  }
  if (!isHexAddress(subaccountOwner)) {
    throw new Error(t("env.invalidNadoAddress"));
  }

  const credentials: NadoCredentials = {
    symbol: getEnv("NADO_SYMBOL", prefix) ?? symbol,
    signerPrivateKey,
    subaccountOwner: subaccountOwner as Address,
    subaccountName: getEnv("NADO_SUBACCOUNT_NAME", prefix) ?? undefined,
    env: getEnv("NADO_ENV", prefix) as any,
    gatewayWsUrl: getEnv("NADO_GATEWAY_WS_URL", prefix) ?? undefined,
    subscriptionsWsUrl: getEnv("NADO_SUBSCRIPTIONS_WS_URL", prefix) ?? undefined,
    archiveUrl: getEnv("NADO_ARCHIVE_URL", prefix) ?? undefined,
    triggerUrl: getEnv("NADO_TRIGGER_URL", prefix) ?? undefined,
    marketSlippagePct: parseOptionalNumber(getEnv("NADO_MARKET_SLIPPAGE_PCT", prefix)),
    stopTriggerSource: getEnv("NADO_STOP_TRIGGER_SOURCE", prefix) as any,
  };

  return credentials;
}

function resolveStandxCredentials(symbol: string, prefix?: string): StandxCredentials {
  const token = getEnv("STANDX_TOKEN", prefix);
  if (!token) {
    throw new Error(t("env.missingStandx"));
  }
  return {
    token,
    symbol: getEnv("STANDX_SYMBOL", prefix) ?? symbol,
    baseUrl: getEnv("STANDX_BASE_URL", prefix) ?? undefined,
    wsUrl: getEnv("STANDX_WS_URL", prefix) ?? undefined,
    sessionId: getEnv("STANDX_SESSION_ID", prefix) ?? undefined,
    signingKey: getEnv("STANDX_REQUEST_PRIVATE_KEY", prefix) ?? undefined,
  };
}

function isHex32(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function isHexAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return true;
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveGrvtCredentials(symbol: string, instrument?: string, prefix?: string): GrvtCredentials {
  // Try to find API Key
  const apiKey = getEnv("GRVT_API_KEY", prefix);
  const apiSecret = getEnv("GRVT_API_SECRET", prefix);

  // If no API Key, maybe Cookie? 
  const cookie = getEnv("GRVT_COOKIE", prefix);

  if (!apiKey && !cookie) {
    // Just warn or allow fallback? GRVT adapter will throw if missing.
    // But we prefer explicit resolution here.
    // throw new Error(t("env.missingGrvt"));
  }

  return {
    symbol,
    instrument: instrument ?? getEnv("GRVT_INSTRUMENT", prefix),
    apiKey,

    apiSecret,
    subAccountId: getEnv("GRVT_SUB_ACCOUNT_ID", prefix),
    cookie,
    accountId: getEnv("GRVT_ACCOUNT_ID", prefix),
    env: getEnv("GRVT_ENV", prefix) as any,
  };
}
