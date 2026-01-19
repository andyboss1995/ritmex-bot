#!/bin/bash
# Usage: ./scripts/deploy_to_server.sh <user@host> <target_dir>
# Example: ./scripts/deploy_to_server.sh root@1.2.3.4 /root/ritmex-bot

HOST=$1
DIR=$2

if [ -z "$HOST" ] || [ -z "$DIR" ]; then
  echo "Usage: $0 <user@host> <target_dir>"
  echo "Example: $0 root@123.456.78.90 /root/ritmex-bot"
  exit 1
fi

echo "Deploying to $HOST:$DIR ..."

# 1. Create directory on remote
ssh $HOST "mkdir -p $DIR"

# 2. Sync files (excluding heavy/local folders)
# We exclude .env.nado by default for safety? No, user needs it. 
# But maybe they want to configure it there. Let's send everything except node_modules/logs
rsync -avz --progress \
  --exclude 'node_modules' \
  --exclude 'logs' \
  --exclude 'data' \
  --exclude '.git' \
  --exclude '.DS_Store' \
  ./ $HOST:$DIR/

echo "---------------------------------------------------"
echo "Files transferred."
echo "Now please login to server and run:"
echo "  ssh $HOST"
echo "  cd $DIR"
echo "  # Install Bun if needed: curl -fsSL https://bun.sh/install | bash"
echo "  # Install PM2: npm install -g pm2"
echo "  bun install"
echo "  pm2 start ecosystem.config.cjs"
echo "---------------------------------------------------"
