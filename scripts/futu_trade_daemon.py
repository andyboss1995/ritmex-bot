#!/usr/bin/env python3
"""Futu 交易常驻进程: TS 端通过 stdin/stdout JSON-RPC 调用.

请求格式 (每行一个 JSON):
  {"id": "req-1", "method": "place_market_buy", "params": {"symbol": "HK.00700", "shares": 200}}

响应格式:
  {"id": "req-1", "ok": true, "result": {...}}
  {"id": "req-1", "ok": false, "error": "reason"}

支持方法:
  health                                   -> {"market_state": "..."}
  unlock {pwd_md5}                         -> {"unlocked": true}
  get_account                              -> {"total_assets": 1234567.0, "cash": ...}
  get_positions                            -> {"positions": [...]}
  place_market_buy {symbol, shares}        -> {"order_id": "..."}
  place_stop_sell {symbol, shares, stop}   -> {"order_id": "..."}
  cancel {order_id}                        -> {"cancelled": true}

启动:
  python3 scripts/futu_trade_daemon.py --host 127.0.0.1 --port 11111 --env SIMULATE --market HK
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import traceback
from typing import Any

# === 关键: 把 fd 1 (协议通道) 备份, 然后将 sys.stdout 重定向到 stderr,
# 这样 futu 底层日志/print 都不会污染 JSON-RPC 通道, 只有 _ok/_err 显式走 PROTO_FD ===
PROTO_FD: Any = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
sys.stdout = sys.stderr  # type: ignore[assignment]

logging.getLogger().setLevel(logging.WARNING)
for name in ("futu", "OpenContextBase", "OpenQuoteContext", "OpenSecTradeContext"):
    logging.getLogger(name).setLevel(logging.WARNING)

from futu import (
    ModifyOrderOp,
    OpenQuoteContext,
    OpenSecTradeContext,
    OrderType,
    RET_OK,
    SecurityFirm,
    TrdEnv,
    TrdMarket,
    TrdSide,
)


def _ok(rid: str, result: Any) -> None:
    PROTO_FD.write(json.dumps({"id": rid, "ok": True, "result": result}, ensure_ascii=False) + "\n")
    PROTO_FD.flush()


def _err(rid: str, msg: str) -> None:
    PROTO_FD.write(json.dumps({"id": rid, "ok": False, "error": msg}, ensure_ascii=False) + "\n")
    PROTO_FD.flush()


def _log(msg: str) -> None:
    sys.stderr.write(f"[daemon] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11111)
    ap.add_argument("--env", choices=["SIMULATE", "REAL"], default="SIMULATE")
    ap.add_argument("--market", choices=["HK", "US", "CN"], default="HK")
    ap.add_argument("--firm", choices=["FUTUSECURITIES", "FUTUINC", "FUTUSG"], default="FUTUSECURITIES")
    args = ap.parse_args()

    trd_env = TrdEnv.SIMULATE if args.env == "SIMULATE" else TrdEnv.REAL
    market = {"HK": TrdMarket.HK, "US": TrdMarket.US, "CN": TrdMarket.CN}[args.market]
    firm = {"FUTUSECURITIES": SecurityFirm.FUTUSECURITIES, "FUTUINC": SecurityFirm.FUTUINC, "FUTUSG": SecurityFirm.FUTUSG}[args.firm]

    quote = OpenQuoteContext(host=args.host, port=args.port)
    trd = OpenSecTradeContext(filter_trdmarket=market, host=args.host, port=args.port, security_firm=firm)
    _log(f"connected: env={args.env} market={args.market}")
    PROTO_FD.write(json.dumps({"event": "ready", "env": args.env, "market": args.market}) + "\n")
    PROTO_FD.flush()

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as e:
                _err("?", f"invalid JSON: {e}")
                continue
            rid = req.get("id", "?")
            method = req.get("method", "")
            params = req.get("params", {}) or {}
            try:
                if method == "health":
                    ret, st = quote.get_global_state()
                    _ok(rid, {"market_hk": st.get("market_hk") if ret == RET_OK else None})
                elif method == "unlock":
                    pwd_md5 = params.get("pwd_md5")
                    if not pwd_md5:
                        _err(rid, "pwd_md5 required")
                        continue
                    if trd_env == TrdEnv.SIMULATE:
                        _ok(rid, {"unlocked": True, "note": "SIMULATE 不需要解锁"})
                    else:
                        ret, data = trd.unlock_trade(password_md5=pwd_md5)
                        if ret == RET_OK:
                            _ok(rid, {"unlocked": True})
                        else:
                            _err(rid, f"unlock failed: {data}")
                elif method == "get_account":
                    ret, data = trd.accinfo_query(trd_env=trd_env)
                    if ret != RET_OK:
                        _err(rid, str(data))
                    else:
                        row = data.iloc[0].to_dict() if len(data) else {}
                        _ok(rid, {
                            "total_assets": float(row.get("total_assets", 0) or 0),
                            "cash": float(row.get("cash", 0) or 0),
                            "market_val": float(row.get("market_val", 0) or 0),
                            "currency": str(row.get("currency", "HKD")),
                            "power": float(row.get("power", 0) or 0),
                        })
                elif method == "get_positions":
                    ret, data = trd.position_list_query(trd_env=trd_env)
                    if ret != RET_OK:
                        _err(rid, str(data))
                    else:
                        rows = data.to_dict("records") if len(data) else []
                        _ok(rid, {"positions": [
                            {
                                "symbol": r.get("code"),
                                "name": r.get("stock_name"),
                                "qty": float(r.get("qty", 0) or 0),
                                "can_sell_qty": float(r.get("can_sell_qty", 0) or 0),
                                "cost_price": float(r.get("cost_price", 0) or 0),
                                "current_price": float(r.get("nominal_price", 0) or 0),
                                "pl_ratio": float(r.get("pl_ratio", 0) or 0),
                                "pl_val": float(r.get("pl_val", 0) or 0),
                            } for r in rows
                        ]})
                elif method == "place_market_buy":
                    symbol = params["symbol"]
                    shares = int(params["shares"])
                    ret, data = trd.place_order(
                        price=0.0, qty=shares, code=symbol,
                        trd_side=TrdSide.BUY, order_type=OrderType.MARKET,
                        trd_env=trd_env,
                    )
                    if ret != RET_OK:
                        _err(rid, str(data))
                    else:
                        row = data.iloc[0].to_dict()
                        _ok(rid, {
                            "order_id": str(row.get("order_id")),
                            "status": str(row.get("order_status")),
                            "filled_avg_price": float(row.get("dealt_avg_price", 0) or 0),
                        })
                elif method == "place_stop_sell":
                    symbol = params["symbol"]
                    shares = int(params["shares"])
                    stop = float(params["stop"])
                    # 港股: 用 STOP_LOSS 单 (跟随触发) + LIMIT 成交; 这里简化为 STOP 触发后市价
                    ret, data = trd.place_order(
                        price=stop, qty=shares, code=symbol,
                        trd_side=TrdSide.SELL, order_type=OrderType.STOP,
                        trd_env=trd_env, aux_price=stop,
                    )
                    if ret != RET_OK:
                        _err(rid, str(data))
                    else:
                        row = data.iloc[0].to_dict()
                        _ok(rid, {
                            "order_id": str(row.get("order_id")),
                            "status": str(row.get("order_status")),
                        })
                elif method == "cancel":
                    order_id = str(params["order_id"])
                    ret, data = trd.modify_order(
                        modify_order_op=ModifyOrderOp.CANCEL,
                        order_id=order_id, qty=0, price=0,
                        trd_env=trd_env,
                    )
                    if ret != RET_OK:
                        _err(rid, str(data))
                    else:
                        _ok(rid, {"cancelled": True})
                else:
                    _err(rid, f"unknown method: {method}")
            except Exception as e:
                _err(rid, f"{type(e).__name__}: {e}\n{traceback.format_exc()[-400:]}")
    finally:
        try:
            quote.close()
        except Exception:
            pass
        try:
            trd.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
