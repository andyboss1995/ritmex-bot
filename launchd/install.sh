#!/usr/bin/env bash
# 安装 launchd 任务: 09:30 entry + 16:30 eod (周一到周五).
set -euo pipefail
cd "$(dirname "$0")"
REPO="$(cd .. && pwd)"

mkdir -p "$REPO/logs"

for f in com.ritmex.hk-momentum.entry.plist com.ritmex.hk-momentum.eod.plist; do
  out="$HOME/Library/LaunchAgents/$f"
  sed "s#REPO_PATH#$REPO#g" "$f" > "$out"
  echo "wrote $out"
  launchctl unload "$out" 2>/dev/null || true
  launchctl load "$out"
  echo "loaded: $f"
done

echo ""
echo "查看任务:"
launchctl list | grep ritmex || true
echo ""
echo "卸载:"
echo "  launchctl unload ~/Library/LaunchAgents/com.ritmex.hk-momentum.entry.plist"
echo "  launchctl unload ~/Library/LaunchAgents/com.ritmex.hk-momentum.eod.plist"
