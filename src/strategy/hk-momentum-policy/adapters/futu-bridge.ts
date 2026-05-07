import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { OrderRouter } from "../market-data";

export interface FutuBridgeOptions {
  pythonBin?: string;
  daemonScript: string;
  host?: string;
  port?: number;
  env?: "SIMULATE" | "REAL";
  market?: "HK" | "US" | "CN";
  firm?: "FUTUSECURITIES" | "FUTUINC" | "FUTUSG";
  unlockPwdMd5?: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface AccountSnapshot {
  totalAssets: number;
  cash: number;
  marketVal: number;
  power: number;
  currency: string;
}

export interface BrokerPosition {
  symbol: string;
  name: string;
  qty: number;
  canSellQty: number;
  costPrice: number;
  currentPrice: number;
  plRatio: number;
  plVal: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FutuTradeBridge implements OrderRouter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private idCounter = 0;
  private ready: Promise<void> | null = null;
  private unlocked = false;

  constructor(private readonly opts: FutuBridgeOptions) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.startInternal();
    return this.ready;
  }

  private startInternal(): Promise<void> {
    const { pythonBin = "python3", daemonScript, host = "127.0.0.1", port = 11111,
            env = "SIMULATE", market = "HK", firm = "FUTUSECURITIES" } = this.opts;
    const args = [daemonScript, "--host", host, "--port", String(port), "--env", env, "--market", market, "--firm", firm];
    const proc = spawn(pythonBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;

    const readyPromise = new Promise<void>((resolve, reject) => {
      const onErr = (data: Buffer) => {
        const line = data.toString();
        if (this.opts.onLog) this.opts.onLog(`[stderr] ${line.trim()}`);
      };
      proc.stderr.on("data", onErr);

      const rl = createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === "ready") {
            resolve();
            return;
          }
          // 忽略非协议行 (如 futu 库的 stdout 日志)
          if (msg.id == null && msg.event == null) {
            if (this.opts.onLog) this.opts.onLog(`[noise] ${line}`);
            return;
          }
          const id = String(msg.id ?? "");
          const p = this.pending.get(id);
          if (!p) {
            if (this.opts.onLog) this.opts.onLog(`[orphan] ${line}`);
            return;
          }
          this.pending.delete(id);
          clearTimeout(p.timer);
          if (msg.ok) p.resolve(msg.result);
          else p.reject(new Error(String(msg.error ?? "unknown error")));
        } catch (e) {
          if (this.opts.onLog) this.opts.onLog(`[parse-err] ${line}`);
        }
      });

      proc.on("exit", (code, signal) => {
        const err = new Error(`futu daemon exited code=${code} signal=${signal}`);
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
        if (this.ready) reject(err);
      });
    });

    return readyPromise.then(async () => {
      if (this.opts.unlockPwdMd5) {
        await this.call<{ unlocked: boolean }>("unlock", { pwd_md5: this.opts.unlockPwdMd5 });
      }
      this.unlocked = true;
    });
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc) throw new Error("FutuTradeBridge not started");
    const id = `r${++this.idCounter}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 15_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`futu daemon timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      this.proc!.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    this.proc.stdin.end();
    await new Promise<void>((res) => {
      this.proc!.once("exit", () => res());
      setTimeout(() => res(), 2000);
    });
    this.proc = null;
  }

  async health(): Promise<{ market_hk: string | null }> {
    return this.call("health");
  }

  async getAccount(): Promise<AccountSnapshot> {
    const r = await this.call<{ total_assets: number; cash: number; market_val: number; power: number; currency: string }>("get_account");
    return { totalAssets: r.total_assets, cash: r.cash, marketVal: r.market_val, power: r.power, currency: r.currency };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const r = await this.call<{ positions: Array<{ symbol: string; name: string; qty: number; can_sell_qty: number; cost_price: number; current_price: number; pl_ratio: number; pl_val: number }> }>("get_positions");
    return r.positions.map((p) => ({
      symbol: p.symbol, name: p.name, qty: p.qty, canSellQty: p.can_sell_qty,
      costPrice: p.cost_price, currentPrice: p.current_price, plRatio: p.pl_ratio, plVal: p.pl_val,
    }));
  }

  // --- OrderRouter 接口 ---
  async submitMarketBuy(symbol: string, shares: number): Promise<{ orderId: string; filledPrice: number }> {
    const r = await this.call<{ order_id: string; status: string; filled_avg_price: number }>("place_market_buy", { symbol, shares });
    return { orderId: r.order_id, filledPrice: r.filled_avg_price };
  }

  async submitMarketSell(symbol: string, shares: number): Promise<{ orderId: string; filledPrice: number }> {
    const r = await this.call<{ order_id: string; status: string; filled_avg_price: number }>("place_market_sell", { symbol, shares });
    return { orderId: r.order_id, filledPrice: r.filled_avg_price };
  }

  async submitStopLoss(symbol: string, shares: number, stopPrice: number): Promise<{ orderId: string }> {
    const r = await this.call<{ order_id: string }>("place_stop_sell", { symbol, shares, stop: stopPrice });
    return { orderId: r.order_id };
  }

  async cancel(orderId: string): Promise<void> {
    await this.call("cancel", { order_id: orderId });
  }
}
