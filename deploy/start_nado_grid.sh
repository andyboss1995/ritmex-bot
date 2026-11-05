#!/bin/bash
set -e

# Load Nado Envs
if [ -f .env.nado ]; then
  export $(cat .env.nado | grep -v '#' | xargs)
else
  echo ".env.nado not found! Please copy from template and configure."
  exit 1
fi

echo "Starting Nado Grid Bot..."
echo "Symbol: $TRADE_SYMBOL"
echo "Volume Target: $DAILY_VOLUME_TARGET"
echo "Maker Only: $GRID_MAKER_ONLY"

# Ensure log directory exists
mkdir -p logs

# Run via Bun
bun run src/index.tsx --strategy $STRATEGY
