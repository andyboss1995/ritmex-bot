#!/usr/bin/env bash
# HK 策略自动每日运行脚本.
#
# 用法:
#   bash scripts/run_daily.sh entry   # 09:30 入场: 拉数据 → 跑策略 → SIMULATE 自动下单
#   bash scripts/run_daily.sh eod     # 16:30 EOD: 复盘账户 + P&L + 写日志
#
# 由 launchd / cron 调度. 自动跳过 HK 假期 + 周末.
# 所有输出落到 logs/daily-YYYY-MM-DD-{entry|eod}.log

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG_DIR="$REPO_DIR/logs"
mkdir -p "$LOG_DIR"

PHASE="${1:-entry}"
DATE_TAG="$(date +%Y-%m-%d)"
LOG_FILE="$LOG_DIR/daily-$DATE_TAG-$PHASE.log"

# 加载 .env
if [ -f "$REPO_DIR/.env" ]; then
  set -a
  source "$REPO_DIR/.env"
  set +a
fi

# 找 bun 和 python3 (launchd 启动时 PATH 是空的, 必须显式)
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
BUN="$(command -v bun || true)"
PYTHON3="$(command -v python3 || true)"
if [ -z "$BUN" ] || [ -z "$PYTHON3" ]; then
  echo "[FATAL] bun=$BUN python3=$PYTHON3 not found" | tee -a "$LOG_FILE"
  exit 1
fi

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

# 周末 / HK 假期跳过
DOW=$(date +%u)  # 1=Mon ... 7=Sun
if [ "$DOW" -ge 6 ]; then
  log "周末 (DOW=$DOW), 跳过."
  exit 0
fi

# HK 节假日: 简单维护一个静态列表 (每年初手动更新). 命中即跳过.
HK_HOLIDAYS_2026="2026-01-01 2026-02-17 2026-02-18 2026-02-19 2026-04-03 2026-04-06 2026-04-07 2026-05-01 2026-05-25 2026-06-19 2026-07-01 2026-09-26 2026-10-01 2026-10-19 2026-12-25"
if [[ " $HK_HOLIDAYS_2026 " == *" $DATE_TAG "* ]]; then
  log "HK 假期, 跳过."
  exit 0
fi

log "=== $PHASE 阶段 ($DATE_TAG) ==="

case "$PHASE" in
  entry)
    log "1/3 拉市场快照..."
    "$PYTHON3" "$REPO_DIR/scripts/futu_pull_snapshot.py" --bars 60 --out "$REPO_DIR/data/hk_snapshot.json" >>"$LOG_FILE" 2>&1 || {
      log "[ERROR] snapshot 失败"; exit 1;
    }
    log "2/3 拉实时新闻 (近 24h)..."
    "$PYTHON3" "$REPO_DIR/scripts/akshare_pull_news_realtime.py" --lookback-hours 24 --out "$REPO_DIR/data/hk_news_live.json" >>"$LOG_FILE" 2>&1 || {
      log "[ERROR] 新闻聚合失败"; exit 1;
    }
    log "3/3 跑策略 (SIMULATE auto-confirm)..."
    "$BUN" run "$REPO_DIR/scripts/hk-policy-live.ts" --auto >>"$LOG_FILE" 2>&1 || {
      log "[ERROR] 策略运行失败 (exit=$?)"; exit 1;
    }
    log "✅ entry 完成"
    ;;
  eod)
    log "EOD 复盘: 账户 + 持仓..."
    "$BUN" run "$REPO_DIR/scripts/hk-policy-bridge-check.ts" >>"$LOG_FILE" 2>&1 || {
      log "[ERROR] EOD 拉取失败"; exit 1;
    }
    log "✅ eod 完成"
    ;;
  *)
    log "未知阶段: $PHASE (合法: entry|eod)"
    exit 1
    ;;
esac
