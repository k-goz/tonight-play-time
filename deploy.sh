#!/bin/bash
# Deploy tonight-play-time to MacBook8

set -e

SERVER="kiss330724@100.81.234.57"
REMOTE_DIR="/opt/tonight-play-time"
SSH_PASS="waJLXcs8"

echo "📦 Packaging project..."
cd /Users/king/AI/tonight-play-time
tar czf /tmp/tonight-play-time.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.tar.gz' \
  .

echo "📤 Uploading to MacBook8..."
sshpass -p "$SSH_PASS" ssh "$SERVER" "sudo mkdir -p $REMOTE_DIR && sudo chown -R $SERVER_USER:$SERVER_USER $REMOTE_DIR" 2>/dev/null || true

cat /tmp/tonight-play-time.tar.gz | sshpass -p "$SSH_PASS" ssh "$SERVER" "cd $REMOTE_DIR && tar xzf -"

echo "🔧 Installing dependencies..."
sshpass -p "$SSH_PASS" ssh "$SERVER" "cd $REMOTE_DIR/backend && pip3 install -r requirements.txt --break-system-packages 2>/dev/null || pip3 install -r requirements.txt"

echo "🔧 Setting up systemd service..."
sshpass -p "$SSH_PASS" ssh "$SERVER" "sudo tee /etc/systemd/system/tonight-play-time.service > /dev/null << 'EOF'
[Unit]
Description=Tonight Play Time API
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR/backend
ExecStart=/usr/bin/python3 -m uvicorn main:app --host 0.0.0.0 --port 8001
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF"

echo "🔧 Starting service..."
sshpass -p "$SSH_PASS" ssh "$SERVER" "sudo systemctl daemon-reload && sudo systemctl enable tonight-play-time && sudo systemctl restart tonight-play-time"

echo "⏳ Waiting for service to start..."
sleep 3

echo "🔍 Checking service status..."
sshpass -p "$SSH_PASS" ssh "$SERVER" "sudo systemctl status tonight-play-time --no-pager"

echo ""
echo "✅ Deployment complete!"
echo "🌐 API endpoint: http://100.81.234.57:8001"
echo "🔗 Health check: http://100.81.234.57:8001/api/health"
