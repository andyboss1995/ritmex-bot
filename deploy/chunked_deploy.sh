#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

VPS_IP="YOUR_VPS_IP"
SSH_KEY="$HOME/.ssh/id_rsa_vps"

echo "Compressing Project..."
# Ensure clean start
rm bots.zip bots.part.* 2>/dev/null
zip -r bots.zip . -x "node_modules/*" ".git/*" "deploy/*" "docs/*" "tests/*" ".DS_Store" "*.webp" "*.png" "*.jpg" > /dev/null

# Get size
SIZE=$(ls -lh bots.zip | awk '{print $5}')
echo "Created bots.zip ($SIZE)"

echo "Splitting into small 1MB chunks to bypass network limit..."
split -b 1m bots.zip bots.part.

echo "Uploading chunks individually..."
for file in bots.part.*; do
    echo "Uploading $file ..."
    # Auto-retry 3 times
    scp -i $SSH_KEY $file root@$VPS_IP:/root/bots/$file || \
    (echo "Retrying $file..." && sleep 2 && scp -i $SSH_KEY $file root@$VPS_IP:/root/bots/$file) || \
    (echo "Retrying $file (Last Attempt)..." && sleep 5 && scp -i $SSH_KEY $file root@$VPS_IP:/root/bots/$file)
    
    if [ $? -ne 0 ]; then
        echo "❌ Failed to upload $file. Please check your network."
        exit 1
    fi
done

echo "Uploading config files..."
scp -i $SSH_KEY deploy/bot1/.env root@$VPS_IP:/root/bots/bot1/
scp -i $SSH_KEY deploy/bot2/.env root@$VPS_IP:/root/bots/bot2/

echo "Reassembling and Deploying on VPS..."
ssh -i $SSH_KEY root@$VPS_IP "bash -s" << 'ENDSSH'
# Load environment
export PATH=$PATH:/root/.bun/bin
source /root/.bashrc

# Reassemble
cd /root/bots
cat bots.part.* > bots.zip
rm bots.part.*

echo "Checking zip integrity..."
if ! unzip -t bots.zip > /dev/null 2>&1; then
    echo "❌ Zip file is corrupted. Reassembly failed."
    ls -lh bots.zip
    exit 1
fi

echo "Unzipping..."
unzip -o bots.zip -d bot1 > /dev/null

# Install Node.js for PM2 (PM2 requires Node, Bun alone might be issues for some PM2 versions)
if ! command -v node &> /dev/null; then
    echo "Installing Node.js for PM2 support..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt install -y nodejs
fi

cd bot1
echo "Installing dependencies..."
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
echo "✅ DEPLOYMENT SUCCESSFUL!"
ENDSSH

# Cleanup local parts
rm bots.part.* bots.zip
