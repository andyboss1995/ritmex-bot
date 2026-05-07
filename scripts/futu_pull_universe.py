#!/usr/bin/env python3
"""
拉取 HSI / HSCEI / HSTECH 成分股 + 港股科技/AI/医药/消费等热点板块成分股, 去重后输出.
然后批量拉日K线. 用法:
    python3 scripts/futu_pull_universe.py --days 540 --out data/hk_universe_kline.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

from futu import (
    AuType,
    KLType,
    Market,
    OpenQuoteContext,
    RET_OK,
    SecurityType,
)


def collect_universe(ctx: OpenQuoteContext, top_n: int) -> list[tuple[str, str]]:
    ret, data = ctx.get_stock_basicinfo(market=Market.HK, stock_type=SecurityType.STOCK)
    if ret != RET_OK:
        print(f"get_stock_basicinfo failed: {data}", file=sys.stderr)
        return []
    all_codes: list[tuple[str, str]] = [(row["code"], row["name"]) for _, row in data.iterrows()]
    print(f"全市场港股(STOCK 类型) 数量: {len(all_codes)}")

    snapshots: list[tuple[str, str, float]] = []
    BATCH = 200
    for i in range(0, len(all_codes), BATCH):
        chunk = all_codes[i : i + BATCH]
        codes = [c for c, _ in chunk]
        ret, snap = ctx.get_market_snapshot(codes)
        if ret != RET_OK:
            print(f"  snapshot batch {i} failed: {snap}", file=sys.stderr)
            continue
        names = {c: n for c, n in chunk}
        for _, row in snap.iterrows():
            t = float(row.get("turnover", 0) or 0)
            snapshots.append((row["code"], names.get(row["code"], row["code"]), t))
        print(f"  snapshot {i+len(chunk)}/{len(all_codes)} ok")
        time.sleep(0.5)

    snapshots.sort(key=lambda x: x[2], reverse=True)
    top = snapshots[:top_n]
    print(f"按当日成交额取前 {top_n} 只 (最低成交 {top[-1][2]/1e6:.1f}M HKD)")
    return [(s, n) for s, n, _ in top]


_REQUEST_LOG: list[float] = []


def _throttle(max_per_window: int = 55, window_s: float = 30.0) -> None:
    now = time.time()
    while _REQUEST_LOG and _REQUEST_LOG[0] < now - window_s:
        _REQUEST_LOG.pop(0)
    if len(_REQUEST_LOG) >= max_per_window:
        wait = window_s - (now - _REQUEST_LOG[0]) + 0.3
        if wait > 0:
            time.sleep(wait)
    _REQUEST_LOG.append(time.time())


def fetch_kline(ctx: OpenQuoteContext, code: str, start: str, end: str):
    all_rows = []
    page_key = None
    retries = 0
    while True:
        _throttle()
        ret, data, page_key = ctx.request_history_kline(
            code,
            start=start,
            end=end,
            ktype=KLType.K_DAY,
            autype=AuType.QFQ,
            max_count=1000,
            page_req_key=page_key,
        )
        if ret != RET_OK:
            msg = str(data)
            if "high frequency" in msg and retries < 3:
                retries += 1
                time.sleep(15)
                continue
            return None, msg
        all_rows.extend(data.to_dict("records"))
        if not page_key:
            break
    return all_rows, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11111)
    ap.add_argument("--days", type=int, default=540)
    ap.add_argument("--max-symbols", type=int, default=300)
    ap.add_argument("--min-turnover", type=float, default=200_000_000.0,
                    help="每日平均成交额下限（HKD），低于此值的标的剔除")
    ap.add_argument("--out", default="data/hk_universe_kline.json")
    args = ap.parse_args()

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    ctx = OpenQuoteContext(host=args.host, port=args.port)
    try:
        ret, state = ctx.get_global_state()
        if ret != RET_OK:
            print(f"get_global_state failed: {state}", file=sys.stderr)
            return 1
        print(f"OpenD connected: hk={state.get('market_hk')} server_ver={state.get('server_ver')}")

        universe = collect_universe(ctx, args.max_symbols)
        print(f"\nuniverse 总数: {len(universe)}")

        out_series = []
        skipped_low_liq = 0
        skipped_err = 0
        for i, (code, name) in enumerate(universe):
            rows, err = fetch_kline(ctx, code, start, end)
            if err:
                skipped_err += 1
                if skipped_err <= 5:
                    print(f"  [{i+1}/{len(universe)}] {code} skipped: {err}")
                continue
            if not rows:
                skipped_err += 1
                continue
            bars = [
                {
                    "date": r["time_key"][:10],
                    "open": float(r["open"]),
                    "high": float(r["high"]),
                    "low": float(r["low"]),
                    "close": float(r["close"]),
                    "volume": float(r["volume"]),
                    "turnover": float(r["turnover"]),
                }
                for r in rows
            ]
            avg_turnover = sum(b["turnover"] for b in bars) / max(1, len(bars))
            if avg_turnover < args.min_turnover:
                skipped_low_liq += 1
                continue
            out_series.append({"symbol": code, "name": name, "bars": bars})
            if (i + 1) % 25 == 0:
                print(f"  progress: {i+1}/{len(universe)} kept={len(out_series)} skipped(liq)={skipped_low_liq} skipped(err)={skipped_err}")

        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"start": start, "end": end, "series": out_series}, f, ensure_ascii=False)
        total_bars = sum(len(s["bars"]) for s in out_series)
        print(f"\nwrote {args.out}: {len(out_series)} symbols, {total_bars} bars")
        print(f"skipped(low liquidity)={skipped_low_liq}, skipped(error)={skipped_err}")
        return 0
    finally:
        ctx.close()


if __name__ == "__main__":
    raise SystemExit(main())
