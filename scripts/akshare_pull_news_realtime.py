#!/usr/bin/env python3
"""多源实时新闻聚合: 财联社快讯 + 东财直播 + 同花顺快讯, 按 (title, pub_time) 去重,
匹配 universe 标的, 写到 data/hk_news_live.json (TS 端 AkshareNewsGrabber 消费).

可被 cron 每 5-10 分钟跑一次.
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
from datetime import datetime, timedelta

import akshare as ak


SECTOR_KEYWORDS = {
    "AI": ["AI", "人工智能", "大模型", "算力", "GPT", "DeepSeek"],
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

POLICY_KEYWORDS = ["央行", "财政部", "发改委", "证监会", "国常会", "再贷款", "降准", "降息", "刺激", "扩围", "试点", "补贴", "审批", "政策", "国务院", "白名单", "回购"]

CODE_PATTERN = re.compile(r"(\d{4,5})\.HK|HK\.(\d{4,5})|港股(\d{4,5})|港股\s*(\d{4,5})", re.IGNORECASE)


def classify(text: str) -> tuple[list[str], list[str]]:
    sectors, kws = [], []
    for sec, words in SECTOR_KEYWORDS.items():
        for w in words:
            if w in text:
                if sec not in sectors:
                    sectors.append(sec)
                if w not in kws:
                    kws.append(w)
    for w in POLICY_KEYWORDS:
        if w in text and w not in kws:
            kws.append(w)
    return sectors, kws


def extract_symbols(text: str, universe_codes: set[str], universe_names: dict[str, str]) -> list[str]:
    """提取文本中提到的港股代码 (HK.xxxxx). 按代码 + 公司名(简体/繁体常见词) 匹配."""
    found: set[str] = set()
    for m in CODE_PATTERN.finditer(text):
        for g in m.groups():
            if not g:
                continue
            code = f"HK.{g.zfill(5)}"
            if code in universe_codes:
                found.add(code)
    # 简单按 universe name 子串匹配 (限制于较长名字, 避免误伤)
    for code, name in universe_names.items():
        if not name:
            continue
        for token in name.replace("-W", "").replace("-SW", "").replace("-B", "").split():
            t = token.strip()
            if len(t) >= 3 and t in text:
                found.add(code)
                break
    return list(found)


def fetch_global_cls() -> list[dict]:
    try:
        df = ak.stock_info_global_cls(symbol="全部")
    except Exception:
        return []
    if df is None or len(df) == 0:
        return []
    rows = []
    for _, r in df.iterrows():
        title = str(r.get("标题", "")).strip()
        content = str(r.get("内容", "")).strip()
        date = str(r.get("发布日期", "")).strip()
        timestr = str(r.get("发布时间", "")).strip()
        if not title or not date:
            continue
        try:
            iso = f"{date}T{timestr or '00:00:00'}+08:00"
        except Exception:
            iso = f"{date}T00:00:00+08:00"
        rows.append({"title": title, "content": content, "publishedAt": iso, "source": "cls"})
    return rows


def fetch_global_em() -> list[dict]:
    try:
        df = ak.stock_info_global_em()
    except Exception:
        return []
    if df is None or len(df) == 0:
        return []
    rows = []
    for _, r in df.iterrows():
        title = str(r.get("标题", "")).strip()
        summary = str(r.get("摘要", "")).strip()
        pub = str(r.get("发布时间", "")).strip()
        if not title or not pub:
            continue
        iso = pub.replace(" ", "T") + "+08:00"
        rows.append({"title": title, "content": summary, "publishedAt": iso, "source": "eastmoney"})
    return rows


def fetch_global_ths() -> list[dict]:
    try:
        df = ak.stock_info_global_ths()
    except Exception:
        return []
    if df is None or len(df) == 0:
        return []
    rows = []
    for _, r in df.iterrows():
        title = str(r.get("标题", "")).strip()
        content = str(r.get("内容", "")).strip()
        pub = str(r.get("发布时间", "")).strip()
        if not title or not pub:
            continue
        iso = pub.replace(" ", "T") + "+08:00"
        rows.append({"title": title, "content": content, "publishedAt": iso, "source": "10jqka"})
    return rows


def fetch_global_sina() -> list[dict]:
    try:
        df = ak.stock_info_global_sina()
    except Exception:
        return []
    if df is None or len(df) == 0:
        return []
    rows = []
    for _, r in df.iterrows():
        content = str(r.get("内容", "")).strip()
        pub = str(r.get("时间", "")).strip()
        if not content or not pub:
            continue
        iso = pub.replace(" ", "T") + "+08:00"
        title = content[:60]
        rows.append({"title": title, "content": content, "publishedAt": iso, "source": "sina"})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="data/hk_universe_kline.json")
    ap.add_argument("--out", default="data/hk_news_live.json")
    ap.add_argument("--lookback-hours", type=int, default=48)
    args = ap.parse_args()

    with open(args.universe, "r", encoding="utf-8") as f:
        uni = json.load(f)
    universe_names = {s["symbol"]: s["name"] for s in uni["series"]}
    universe_codes = set(universe_names.keys())
    print(f"universe size = {len(universe_codes)}")

    # 板块 → symbols 反向映射 (从 hk_news.json bySymbol 推导)
    sector_to_symbols: dict[str, list[str]] = defaultdict(list)
    history_path = "data/hk_news.json"
    if os.path.exists(history_path):
        try:
            hist = json.load(open(history_path, "r", encoding="utf-8"))
            for sym, items in hist.get("bySymbol", {}).items():
                if sym not in universe_codes:
                    continue
                seen_sec: set[str] = set()
                for it in items:
                    for sec in it.get("sectors", []):
                        if sec in seen_sec:
                            continue
                        seen_sec.add(sec)
                        sector_to_symbols[sec].append(sym)
            print(f"sector → symbols 映射: {len(sector_to_symbols)} 板块, {sum(len(v) for v in sector_to_symbols.values())} 关联")
        except Exception as e:
            print(f"  load hk_news.json failed: {e}")

    all_raw: list[dict] = []
    for label, fn in [("cls", fetch_global_cls), ("eastmoney", fetch_global_em), ("10jqka", fetch_global_ths), ("sina", fetch_global_sina)]:
        rows = fn()
        print(f"  {label}: {len(rows)}")
        all_raw.extend(rows)

    # 时间过滤
    cutoff = datetime.now().astimezone() - timedelta(hours=args.lookback_hours)
    filtered = []
    for r in all_raw:
        try:
            t = datetime.fromisoformat(r["publishedAt"])
            if t.astimezone() < cutoff:
                continue
        except Exception:
            pass
        filtered.append(r)
    print(f"  时间过滤后 (近 {args.lookback_hours}h): {len(filtered)}")

    # 去重: 按 (title 前 40 字, pub_time 前 16 字)
    seen: set[tuple[str, str]] = set()
    deduped = []
    for r in filtered:
        key = (r["title"][:40], r["publishedAt"][:16])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    print(f"  去重后: {len(deduped)}")

    # 转 NewsItem 格式
    by_date: dict[str, list[dict]] = defaultdict(list)
    by_symbol: dict[str, list[dict]] = defaultdict(list)
    items_with_symbols = 0
    items_no_symbol = 0
    for r in deduped:
        text = f"{r['title']} {r['content']}"
        sectors, kws = classify(text)
        symbols = extract_symbols(text, universe_codes, universe_names)
        # 板块反查: 命中板块的所有 universe 股票都列为受益标的
        if not symbols and sectors:
            sym_set: set[str] = set()
            for sec in sectors:
                for s in sector_to_symbols.get(sec, []):
                    sym_set.add(s)
            symbols = list(sym_set)
        nid = hashlib.md5(f"{r['title']}|{r['publishedAt']}".encode("utf-8")).hexdigest()[:16]
        item = {
            "id": nid,
            "title": r["title"],
            "summary": r["content"][:300],
            "source": r["source"],
            "publishedAt": r["publishedAt"],
            "symbols": symbols,
            "sectors": sectors,
            "keywords": kws,
        }
        date = r["publishedAt"][:10]
        by_date[date].append(item)
        for s in symbols:
            by_symbol[s].append(item)
        if symbols:
            items_with_symbols += 1
        else:
            items_no_symbol += 1

    out = {
        "fetchedAt": datetime.now().astimezone().isoformat(),
        "lookbackHours": args.lookback_hours,
        "byDate": {d: by_date[d] for d in sorted(by_date.keys())},
        "bySymbol": dict(by_symbol),
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"\nwrote {args.out}: {sum(len(v) for v in by_date.values())} items")
    print(f"  匹配到具体港股标的: {items_with_symbols}")
    print(f"  仅板块/关键词信号: {items_no_symbol}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
