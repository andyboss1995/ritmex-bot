#!/bin/bash
echo "Starting GRVT Dual-Account Hedging Strategy..."

# Start with PM2
pm2 start bun --name "grvt-hedging" --cwd . --restart-delay 5000 -- \
    run index.ts \
    --env-file ./.env.hedging \
    --strategy hedging

echo "✅ Hedging Bot Started!"
echo "Use 'pm2 logs grvt-hedging' to monitor."
