#!/bin/bash
VPS_IP="${VPS_IP:?set VPS_IP}"
echo "Setting up SSH Key to avoid password inputs..."
# Verify if key exists, if not created above, create it.
if [ ! -f ~/.ssh/id_rsa_vps ]; then
    ssh-keygen -t rsa -b 4096 -f ~/.ssh/id_rsa_vps -N ""
fi

echo "Copying ID to VPS (You will need to enter password ONE LAST TIME)..."
ssh-copy-id -i ~/.ssh/id_rsa_vps.pub root@$VPS_IP

echo "Testing connection..."
ssh -i ~/.ssh/id_rsa_vps root@$VPS_IP "echo 'SSH Key Setup Success!'"
