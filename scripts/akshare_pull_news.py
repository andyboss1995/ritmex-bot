#!/usr/bin/env python3
"""为 universe 里每只港股拉 AKShare stock_news_em 历史新闻, 输出
data/hk_news.json 给 TS 端 backtest 消费.

输出格式:
{
  "byDate": { "YYYY-MM-DD": [ NewsItem, ... ] },
  "bySymbol": { "HK.00700": [ NewsItem, ... ] }
}
NewsItem: { id, title, summary, source, publishedAt(ISO), symbols, sectors, keywords }
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import time
from collections import defaultdict

import akshare as ak


SECTOR_KEYWORDS = {
    "AI": ["AI", "人工智能", "大模型", "算力", "GPT", "deepseek", "DeepSeek"],
    "半导体": ["半导体", "芯片", "晶圆", "封测", "光刻"],
    "新能源车": ["新能源车", "电动车", "锂电", "电池", "充电桩"],
    "光伏": ["光伏", "硅料", "硅片", "组件", "多晶硅"],
    "医药": ["医药", "创新药", "生物", "疫苗", "GLP-1"],
    "互联网": ["互联网", "电商", "社交", "游戏"],
    "金融": ["银行", "保险", "券商", "信托"],
    "地产": ["地产", "物业", "基建"],
    "消费": ["消费", "零售", "白酒", "餐饮", "茶饮"],
    "航空": ["航空", "航司", "民航"],
    "石油": ["石油", "原油", "炼化"],
    "电信": ["电信", "运营商", "5G", "6G"],
}

POLICY_KEYWORDS = ["央行", "财政部", "发改委", "证监会", "国常会", "再贷款", "降准", "降息", "刺激", "扩围", "试点", "补贴", "审批", "政策", "国务院", "白名单"]


def classify(text: str) -> tuple[list[str], list[str]]:
    sectors = []
    keywords = []
    for sec, kws in SECTOR_KEYWORDS.items():
        for kw in kws:
            if kw in text:
                if sec not in sectors:
                    sectors.append(sec)
                if kw not in keywords:
                    keywords.append(kw)
    for kw in POLICY_KEYWORDS:
        if kw in text and kw not in keywords:
            keywords.append(kw)
    return sectors, keywords


def hk_short(code: str) -> str:
    """HK.00700 → 00700"""
    return code.replace("HK.", "").lstrip("0") or "0"


def fetch_for_symbol(code: str, name: str) -> list[dict]:
    short = code.replace("HK.", "")
    try:
        df = ak.stock_news_em(symbol=short)
    except Exception as e:
        return []
    if df is None or len(df) == 0:
        return []
    items = []
    for _, row in df.iterrows():
        title = str(row.get("新闻标题", "")).strip()
        content = str(row.get("新闻内容", "")).strip()
        pub = str(row.get("发布时间", "")).strip()
        src = str(row.get("文章来源", "")).strip()
        if not title or not pub:
            continue
        text = f"{title} {content}"
        sectors, keywords = classify(text)
        nid = hashlib.md5(f"{code}|{title}|{pub}".encode("utf-8")).hexdigest()[:16]
        try:
            iso = pub.replace(" ", "T") + "+08:00"
        except Exception:
            iso = pub
        items.append({
            "id": nid,
            "title": title,
            "summary": content[:300],
            "source": src or "eastmoney",
            "publishedAt": iso,
            "symbols": [code],
            "sectors": sectors,
            "keywords": keywords,
        })
    return items


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="data/hk_universe_kline.json")
    ap.add_argument("--out", default="data/hk_news.json")
    ap.add_argument("--throttle", type=float, default=0.6, help="每只股之间 sleep 秒")
    args = ap.parse_args()

    with open(args.universe, "r", encoding="utf-8") as f:
        uni = json.load(f)
    series = uni["series"]
    print(f"universe 大小: {len(series)} 只")

    by_date: dict[str, list[dict]] = defaultdict(list)
    by_symbol: dict[str, list[dict]] = {}
    seen_ids: set[str] = set()
    total_news = 0
    fail = 0

    for i, s in enumerate(series):
        code = s["symbol"]
        name = s["name"]
        try:
            items = fetch_for_symbol(code, name)
        except Exception as e:
            fail += 1
            print(f"  [X] {code} {name}: {str(e)[:80]}")
            continue
        if not items:
            print(f"  [{i+1}/{len(series)}] {code} {name}: 0 news")
        else:
            by_symbol[code] = items
            for it in items:
                if it["id"] in seen_ids:
                    continue
                seen_ids.add(it["id"])
                date = it["publishedAt"][:10]
                by_date[date].append(it)
                total_news += 1
            print(f"  [{i+1}/{len(series)}] {code} {name}: {len(items)} news")
        time.sleep(args.throttle)

    # 按日期排序
    by_date_sorted = {d: by_date[d] for d in sorted(by_date.keys())}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"byDate": by_date_sorted, "bySymbol": by_symbol}, f, ensure_ascii=False)
    if by_date_sorted:
        dates = list(by_date_sorted.keys())
        print(f"\nwrote {args.out}: {total_news} 条新闻, {len(by_symbol)} 只股有新闻")
        print(f"日期范围 {dates[0]} -> {dates[-1]} ({len(dates)} 天)")
    print(f"失败 {fail} 只")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
