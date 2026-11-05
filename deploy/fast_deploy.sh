#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

VPS_IP="${VPS_IP:?set VPS_IP}"
SSH_KEY="$HOME/.ssh/id_rsa_vps"

echo "Compressing..."
# Reduce size by excluding more unnecessary files
zip -r bots.zip . -x "node_modules/*" ".git/*" "deploy/*" "docs/*" "tests/*" ".DS_Store" "*.webp" "*.png" "*.jpg" > /dev/null

echo "Uploading directly via SCP (Compressed)..."
echo "This uses your SSH connection, so it should work even if transfer.sh is blocked."
scp -C -i $SSH_KEY ./bots.zip root@$VPS_IP:/root/bots/bots.zip

echo "Uploading config files..."
scp -i $SSH_KEY deploy/bot1/.env root@$VPS_IP:/root/bots/bot1/
scp -i $SSH_KEY deploy/bot2/.env root@$VPS_IP:/root/bots/bot2/

echo "Executing setup on VPS..."
ssh -i $SSH_KEY root@$VPS_IP "bash -s" << 'ENDSSH'
# Load environment
export PATH=$PATH:/root/.bun/bin
source /root/.bashrc

# Check file
ls -lh /root/bots/bots.zip

echo "Unzipping..."
unzip -o /root/bots/bots.zip -d /root/bots/bot1 > /dev/null

cd /root/bots/bot1
echo "Installing dependencies (bun install)..."
bun install

echo "Copying to bot2..."
mkdir -p /root/bots/bot2
cp -r /root/bots/bot1/* /root/bots/bot2/

echo "Starting Bots..."
pm2 delete all 2>/dev/null || true

# Start Bot 1
cd /root/bots/bot1
pm2 start bun --name "bot1" -- run index.ts --strategy maker-points --exchange standx --silent

# Start Bot 2
cd /root/bots/bot2
pm2 start bun --name "bot2" -- run index.ts --strategy maker-points --exchange standx --silent

pm2 save
pm2 list
ENDSSH

rm bots.zip
echo "Deployment Finished Successfully!"
