#!/bin/bash
pm2 delete grvt-bot1-long grvt-bot2-short 2>/dev/null || true
echo "✅ GRVT Bots Stopped Successfully"
