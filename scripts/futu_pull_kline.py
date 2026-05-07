#!/usr/bin/env python3
"""
连接本机 OpenD (127.0.0.1:11111), 拉取港股日 K 线, 导出为 JSON 供 TS 回测使用.
用法:
    python3 scripts/futu_pull_kline.py [--days 365] [--out data/hk_kline.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta

from futu import OpenQuoteContext, KLType, AuType, RET_OK


DEFAULT_UNIVERSE = [
    ("HK.00700", "腾讯控股"),
    ("HK.09988", "阿里巴巴-W"),
    ("HK.03690", "美团-W"),
    ("HK.09618", "京东集团-SW"),
    ("HK.01810", "小米集团-W"),
    ("HK.00388", "香港交易所"),
    ("HK.00939", "建设银行"),
    ("HK.01299", "友邦保险"),
    ("HK.02318", "中国平安"),
    ("HK.00005", "汇丰控股"),
    ("HK.00883", "中国海洋石油"),
    ("HK.01024", "快手-W"),
    ("HK.09888", "百度集团-SW"),
    ("HK.06618", "京东健康"),
    ("HK.02382", "舜宇光学科技"),
]


def fetch_kline(ctx: OpenQuoteContext, code: str, start: str, end: str):
    all_rows = []
    page_key = None
    while True:
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
            raise RuntimeError(f"history_kline failed for {code}: {data}")
        all_rows.extend(data.to_dict("records"))
        if not page_key:
            break
        time.sleep(0.4)
    return all_rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11111)
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--out", default="data/hk_kline.json")
    args = ap.parse_args()

    end = datetime.now().strftime("%Y-%m-%d")
    start = (datetime.now() - timedelta(days=args.days)).strftime("%Y-%m-%d")

    ctx = OpenQuoteContext(host=args.host, port=args.port)
    try:
        ret, state = ctx.get_global_state()
        if ret != RET_OK:
            print(f"get_global_state failed: {state}", file=sys.stderr)
            return 1
        print(f"OpenD connected: market_hk_state={state.get('market_hk')} server_ver={state.get('server_ver')}")

        out_series = []
        for code, name in DEFAULT_UNIVERSE:
            print(f"  pulling {code} {name} ...", flush=True)
            rows = fetch_kline(ctx, code, start, end)
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
            out_series.append({"symbol": code, "name": name, "bars": bars})
            print(f"    {len(bars)} bars: {bars[0]['date'] if bars else '-'} -> {bars[-1]['date'] if bars else '-'}")

        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump({"start": start, "end": end, "series": out_series}, f, ensure_ascii=False)
        print(f"wrote {args.out} ({sum(len(s['bars']) for s in out_series)} bars total)")
        return 0
    finally:
        ctx.close()


if __name__ == "__main__":
    raise SystemExit(main())
