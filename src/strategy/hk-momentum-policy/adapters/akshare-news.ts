import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { NewsGrabber } from "../policy-agent";
import type { NewsItem } from "../types";

interface NewsCacheFile {
  fetchedAt?: string;
  lookbackHours?: number;
  byDate: Record<string, NewsItem[]>;
  bySymbol: Record<string, NewsItem[]>;
}

export interface AkshareNewsGrabberOptions {
  cachePath: string;
  pythonBin?: string;
  refreshScript?: string;
  refreshArgs?: string[];
  /** 缓存最旧多少分钟仍可用; 超过则触发刷新 */
  maxStaleMinutes?: number;
}

/**
 * 读 Python akshare_pull_news_realtime.py 写出的 JSON 缓存.
 * 缓存过期时主动调用 Python 脚本刷新.
 */
export class AkshareNewsGrabber implements NewsGrabber {
  constructor(private readonly opts: AkshareNewsGrabberOptions) {}

  private isStale(): boolean {
    if (!existsSync(this.opts.cachePath)) return true;
    const max = this.opts.maxStaleMinutes ?? 10;
    const ageMs = Date.now() - statSync(this.opts.cachePath).mtimeMs;
    return ageMs > max * 60_000;
  }

  private refresh(lookbackHours: number): void {
    if (!this.opts.refreshScript) return;
    const py = this.opts.pythonBin ?? "python3";
    const args = [
      this.opts.refreshScript,
      "--out",
      this.opts.cachePath,
      "--lookback-hours",
      String(lookbackHours),
      ...(this.opts.refreshArgs ?? []),
    ];
    const r = spawnSync(py, args, { stdio: "pipe", encoding: "utf8", timeout: 60_000 });
    if (r.status !== 0) {
      const err = (r.stderr ?? "").trim() || (r.stdout ?? "").trim();
      throw new Error(`AkshareNewsGrabber refresh failed (exit ${r.status}): ${err.slice(0, 300)}`);
    }
  }

  async fetch(symbols: string[], lookbackHours: number): Promise<NewsItem[]> {
    if (this.isStale()) {
      try {
        this.refresh(lookbackHours);
      } catch (e) {
        console.error(`[AkshareNewsGrabber] refresh failed; using stale cache: ${(e as Error).message}`);
        if (!existsSync(this.opts.cachePath)) return [];
      }
    }
    const raw: NewsCacheFile = JSON.parse(readFileSync(this.opts.cachePath, "utf8"));
    const cutoff = Date.now() - lookbackHours * 3600_000;
    const symSet = new Set(symbols);
    const out: NewsItem[] = [];
    const seen = new Set<string>();
    for (const items of Object.values(raw.byDate ?? {})) {
      for (const it of items) {
        const ts = Date.parse(it.publishedAt);
        if (Number.isFinite(ts) && ts < cutoff) continue;
        const matchSyms = (it.symbols ?? []).filter((s) => symSet.has(s));
        if (matchSyms.length === 0) continue;
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push({ ...it, symbols: matchSyms });
      }
    }
    return out;
  }
}
