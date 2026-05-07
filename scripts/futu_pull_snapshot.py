#!/usr/bin/env python3
"""为 universe 拉取当前市场快照 (近 60 日 K + 当日报价), 写到
data/hk_snapshot.json 给 TS 端 dry-run runner 消费.

用法: python3 scripts/futu_pull_snapshot.py --universe data/hk_universe_kline.json --bars 60 --out data/hk_snapshot.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

from futu import AuType, KLType, OpenQuoteContext, RET_OK


_REQ_LOG: list[float] = []


def _throttle(max_per_window: int = 55, window_s: float = 30.0) -> None:
    now = time.time()
    while _REQ_LOG and _REQ_LOG[0] < now - window_s:
        _REQ_LOG.pop(0)
    if len(_REQ_LOG) >= max_per_window:
        wait = window_s - (now - _REQ_LOG[0]) + 0.3
        if wait > 0:
            time.sleep(wait)
    _REQ_LOG.append(time.time())


def fetch_recent_kline(ctx: OpenQuoteContext, code: str, bars: int):
    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=int(bars * 1.6) + 30)).strftime("%Y-%m-%d")
    _throttle()
    ret, data, _ = ctx.request_history_kline(
        code,
        start=start,
        end=end,
        ktype=KLType.K_DAY,
        autype=AuType.QFQ,
        max_count=bars + 5,
    )
    if ret != RET_OK:
        return None, str(data)
    return data.to_dict("records"), None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11111)
    ap.add_argument("--universe", default="data/hk_universe_kline.json")
    ap.add_argument("--bars", type=int, default=60)
    ap.add_argument("--out", default="data/hk_snapshot.json")
    args = ap.parse_args()

    with open(args.universe, "r", encoding="utf-8") as f:
        uni = json.load(f)
    symbols = [(s["symbol"], s["name"]) for s in uni["series"]]
    print(f"universe size = {len(symbols)}")

    ctx = OpenQuoteContext(host=args.host, port=args.port)
    try:
        ret, state = ctx.get_global_state()
        if ret != RET_OK:
            print(f"get_global_state failed: {state}", file=sys.stderr)
            return 1
        print(f"OpenD connected: hk={state.get('market_hk')}")

        # 当日实时报价批量拉
        codes = [c for c, _ in symbols]
        snap_map: dict[str, dict] = {}
        BATCH = 200
        for i in range(0, len(codes), BATCH):
            chunk = codes[i : i + BATCH]
            _throttle()
            ret, snap = ctx.get_market_snapshot(chunk)
            if ret != RET_OK:
                print(f"  snapshot batch {i} failed: {snap}", file=sys.stderr)
                continue
            for _, row in snap.iterrows():
                snap_map[row["code"]] = {
                    "last": float(row.get("last_price", 0) or 0),
                    "preClose": float(row.get("prev_close_price", 0) or 0),
                    "volume": float(row.get("volume", 0) or 0),
                    "turnover": float(row.get("turnover", 0) or 0),
                    "name": row.get("name", ""),
                }

        # 历史 K 线
        out_series = []
        for i, (code, name) in enumerate(symbols):
            rows, err = fetch_recent_kline(ctx, code, args.bars)
            if err or not rows:
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
            q = snap_map.get(code, {})
            out_series.append({
                "symbol": code,
                "name": q.get("name") or name,
                "bars": bars,
                "lastPrice": q.get("last") or (bars[-1]["close"] if bars else 0),
                "preClose": q.get("preClose") or (bars[-2]["close"] if len(bars) >= 2 else 0),
                "intradayVolume": q.get("volume") or 0,
            })
            if (i + 1) % 25 == 0:
                print(f"  {i+1}/{len(symbols)}")

        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({
                "fetchedAt": datetime.now().astimezone().isoformat(),
                "marketState": state.get("market_hk"),
                "snapshots": out_series,
            }, f, ensure_ascii=False)
        print(f"\nwrote {args.out}: {len(out_series)} symbols")
        return 0
    finally:
        ctx.close()


if __name__ == "__main__":
    raise SystemExit(main())
