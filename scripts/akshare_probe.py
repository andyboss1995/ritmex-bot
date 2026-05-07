#!/usr/bin/env python3
"""探 AKShare 各新闻接口的可用性 + 历史深度 + 港股覆盖度."""
from __future__ import annotations

import sys
import traceback

import akshare as ak

print(f"akshare {ak.__version__}\n")


def try_fn(label: str, fn):
    try:
        df = fn()
        if df is None or len(df) == 0:
            print(f"[空]   {label}")
            return None
        # 找时间字段
        time_col = None
        for c in df.columns:
            if any(k in str(c).lower() for k in ["时间", "日期", "time", "date", "pub_time"]):
                time_col = c
                break
        rng = ""
        if time_col is not None:
            try:
                rng = f" 时间范围 {df[time_col].min()} -> {df[time_col].max()}"
            except Exception:
                pass
        print(f"[OK]  {label}: {len(df)} rows, cols={list(df.columns)[:6]}{rng}")
        return df
    except Exception as e:
        msg = str(e)[:140].replace("\n", " ")
        print(f"[X]   {label}: {msg}")
        return None


# 1. 财联社电报（实时）
df1 = try_fn("stock_zh_a_alerts_cls (财联社电报)", lambda: ak.stock_zh_a_alerts_cls())

# 2. 财联社全球财经快讯
df2 = try_fn("stock_info_global_cls (财联社快讯-全球)", lambda: ak.stock_info_global_cls(symbol="全部"))

# 3. 东财全球新闻
df3 = try_fn("stock_info_global_em (东财全球财经直播)", lambda: ak.stock_info_global_em())

# 4. 东财个股新闻 (HK)
df4 = try_fn("stock_news_em(00700.HK)", lambda: ak.stock_news_em(symbol="00700"))

# 5. 同花顺财经新闻
df5 = try_fn("stock_info_global_ths (同花顺快讯)", lambda: ak.stock_info_global_ths())

# 6. 新浪财经全球
df6 = try_fn("stock_info_global_sina (新浪财经)", lambda: ak.stock_info_global_sina())

# 7. 港股个股新闻
df7 = try_fn("stock_news_main_cx (财新)", lambda: ak.stock_news_main_cx())

# 看一条样本
for label, df in [("财联社电报", df1), ("财联社全球", df2), ("东财直播", df3), ("00700 个股", df4), ("同花顺", df5), ("新浪", df6)]:
    if df is not None and len(df):
        print(f"\n=== 样本: {label} ===")
        print(df.head(3).to_string())
        break
