#!/bin/bash

# Ensure we are in the project root
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

# Configuration
VPS_IP="${VPS_IP:?set VPS_IP}"
USER="${VPS_USER:-root}"
# We exclude node_modules and .git to make upload fast
echo "Compressing project files..."
zip -r bots.zip . -x "node_modules/*" ".git/*" "deploy/*" "docs/*" "tests/*" ".DS_Store"

echo "Creating remote directories..."
ssh $USER@$VPS_IP "mkdir -p /root/bots/bot1 /root/bots/bot2"

echo "Uploading files (Please enter password if prompted)..."
scp bots.zip $USER@$VPS_IP:/root/bots/
scp deploy/bot1/.env $USER@$VPS_IP:/root/bots/bot1/
scp deploy/bot2/.env $USER@$VPS_IP:/root/bots/bot2/

echo "Executing setup on VPS..."
ssh $USER@$VPS_IP "bash -s" << 'ENDSSH'
# Unzip to bot1
echo "Unzipping..."
unzip -o /root/bots/bots.zip -d /root/bots/bot1 > /dev/null

# Install dependencies in bot1
echo "Installing dependencies (this may take a minute)..."
cd /root/bots/bot1
bun install

# Copy code to bot2 (reuse node_modules to save time)
echo "Cloning to bot2..."
cp -r /root/bots/bot1/* /root/bots/bot2/
# Overwrite .env for bot2 (it was already uploaded to dir, but cp might have overwritten it, so we copy it back if needed, wait scp put it in dir, cp -r overwrites files. we should copy code first then scp env. Or scp env after cp.)
# My scp command put .env in destination. cp -r source dest will overwrite destination files. Aaargh.
# Fix: Upload .env AFTER copy.
ENDSSH

echo "Re-uploading .env files to ensure they are correct..."
scp deploy/bot1/.env $USER@$VPS_IP:/root/bots/bot1/
scp deploy/bot2/.env $USER@$VPS_IP:/root/bots/bot2/

echo "Starting bots..."
ssh $USER@$VPS_IP "bash -s" << 'ENDSSH'
# Start Bot 1
cd /root/bots/bot1
pm2 start bun --name "bot1" -- run index.ts --strategy maker-points --exchange standx --silent

# Start Bot 2
cd /root/bots/bot2
pm2 start bun --name "bot2" -- run index.ts --strategy maker-points --exchange standx --silent

pm2 save
pm2 list
ENDSSH

echo "Deployment Complete! Cleaning up local zip..."
rm bots.zip

echo "You can check logs by logging into VPS and running 'pm2 logs'"



cat > deploy/fast_deploy.sh << 'EOF'
#!/bin/bash
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

VPS_IP="${VPS_IP:?set VPS_IP}"

echo "Compressing..."
zip -r bots.zip . -x "node_modules/*" ".git/*" "deploy/*" "docs/*" "tests/*" ".DS_Store" > /dev/null

echo "Uploading to Transfer.sh (waiting for link)..."
DOWNLOAD_URL=$(curl --upload-file ./bots.zip https://transfer.sh/bots.zip)
echo "Link generated: $DOWNLOAD_URL"

echo "Triggering download on VPS..."
ssh root@$VPS_IP "wget $DOWNLOAD_URL -O /root/bots/bots.zip && mkdir -p /root/bots/bot1 /root/bots/bot2"

echo "Uploading small config files (these are fast)..."
scp deploy/bot1/.env root@$VPS_IP:/root/bots/bot1/
scp deploy/bot2/.env root@$VPS_IP:/root/bots/bot2/

echo "Executing setup..."
ssh root@$VPS_IP "bash -s" << 'ENDSSH'
# Unzip
echo "Unzipping..."
unzip -o /root/bots/bots.zip -d /root/bots/bot1 > /dev/null
cd /root/bots/bot1
bun install

echo "Copying to bot2..."
cp -r /root/bots/bot1/* /root/bots/bot2/

echo "Starting Bots..."
pm2 start bun --name "bot1" -- run index.ts --strategy maker-points --exchange standx --silent
cd /root/bots/bot2
pm2 start bun --name "bot2" -- run index.ts --strategy maker-points --exchange standx --silent
pm2 save
pm2 list
ENDSSH

rm bots.zip
echo "Done!"
EOF


chmod +x deploy/fast_deploy.sh
./deploy/fast_deploy.sh