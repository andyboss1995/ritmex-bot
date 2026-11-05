#!/usr/bin/env python3
"""探针：用 Tushare token 试一遍所有可能给我们用的新闻/快讯接口，输出权限矩阵.
正式拉数据前先看哪几个能用、需要多少积分."""
from __future__ import annotations

import os
import sys
from datetime import datetime, timedelta

import tushare as ts


TOKEN = os.environ.get("TUSHARE_TOKEN", "").strip()
if not TOKEN:
    sys.exit("TUSHARE_TOKEN is required")

ts.set_token(TOKEN)
pro = ts.pro_api()

end = datetime.now()
start = end - timedelta(days=2)
fmt_ts = "%Y-%m-%d %H:%M:%S"
fmt_d = "%Y%m%d"

probes = [
    ("news (财联社)",          lambda: pro.news(src="sina", start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts))),
    ("news (财联社 cls)",      lambda: pro.news(src="cls", start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts))),
    ("news (10jqka)",          lambda: pro.news(src="10jqka", start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts))),
    ("news (eastmoney)",       lambda: pro.news(src="eastmoney", start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts))),
    ("news (yuncaijing)",      lambda: pro.news(src="yuncaijing", start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts))),
    ("major_news (重大新闻)",   lambda: pro.major_news(start_date=start.strftime(fmt_ts), end_date=end.strftime(fmt_ts), fields="title,content,pub_time,src")),
    ("cctv_news (新闻联播)",    lambda: pro.cctv_news(date=end.strftime(fmt_d))),
    ("anns_d (港股/A 公告)",    lambda: pro.anns_d(start_date=end.strftime(fmt_d), end_date=end.strftime(fmt_d), market="HK")),
    ("hk_basic (港股清单)",     lambda: pro.hk_basic(list_status="L")),
    ("hk_daily (港股日 K)",     lambda: pro.hk_daily(ts_code="00700.HK", start_date=(end-timedelta(days=30)).strftime(fmt_d), end_date=end.strftime(fmt_d))),
]

ok = []
fail = []
for label, fn in probes:
    try:
        df = fn()
        if df is None or len(df) == 0:
            print(f"  [空]  {label}: 0 rows")
            continue
        print(f"  [OK]  {label}: {len(df)} rows, cols={list(df.columns)[:8]}")
        ok.append(label)
    except Exception as e:
        msg = str(e)[:160].replace("\n", " ")
        print(f"  [X]   {label}: {msg}")
        fail.append((label, msg))

print(f"\nSummary: 可用 {len(ok)}, 失败 {len(fail)}")
for n, m in fail:
    print(f"  - {n}: {m}")
