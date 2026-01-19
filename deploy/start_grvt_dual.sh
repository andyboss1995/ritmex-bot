#!/bin/bash

# Ensure pm2 is installed
if ! command -v pm2 &> /dev/null; then
    echo "PM2 not found. Installing..."
    npm install -g pm2
fi

echo "Starting GRVT Dual-Bot Strategy..."

# Cleanup old processes to prevent duplicates
echo "Cleaning up old processes..."
pm2 delete grvt-bot1-long grvt-bot2-short 2>/dev/null || true

# Start Bot 1 (Long)
echo "Launching Bot 1 (Long Grid)..."
pm2 start bun --name "grvt-bot1-long" --cwd . --restart-delay 5000 -- \
    run index.ts \
    --env-file ./deploy/bot1/.env.grvt \
    --strategy grid

# Start Bot 2 (Short)
echo "Launching Bot 2 (Short Grid)..."
pm2 start bun --name "grvt-bot2-short" --cwd . --restart-delay 5000 -- \
    run index.ts \
    --env-file ./deploy/bot2/.env.grvt \
    --strategy grid

echo "---------------------------------------------------"
echo "✅ Both bots started!"
echo "View logs with: pm2 logs"
echo "Monitor status with: pm2 monit"
echo "---------------------------------------------------"
