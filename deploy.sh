#!/bin/bash
# Deploy tonight-play-time with SSH key authentication

set -e

: "${DEPLOY_SERVER:?Set DEPLOY_SERVER, for example user@host}"
REMOTE_DIR="${DEPLOY_REMOTE_DIR:-/opt/tonight-play-time}"

echo "📦 Packaging project..."
cd /Users/king/AI/tonight-play-time
tar czf /tmp/tonight-play-time.tar.gz \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='*.tar.gz' \
  .

echo "📤 Uploading to MacBook8..."
ssh "$DEPLOY_SERVER" "mkdir -p '$REMOTE_DIR'"

ssh "$DEPLOY_SERVER" "cd '$REMOTE_DIR' && tar xzf -" < /tmp/tonight-play-time.tar.gz

echo "🔧 Installing dependencies..."
ssh "$DEPLOY_SERVER" "cd '$REMOTE_DIR' && npm install --omit=dev"

echo "🔧 Setting up systemd service..."
ssh "$DEPLOY_SERVER" "sudo tee /etc/systemd/system/tonight-play-time.service > /dev/null << 'EOF'
[Unit]
Description=Tonight Play Time API
After=network.target

[Service]
Type=simple
WorkingDirectory=$REMOTE_DIR
ExecStart=/usr/bin/node backend/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=8001

[Install]
WantedBy=multi-user.target
EOF"

echo "🔧 Starting service..."
ssh "$DEPLOY_SERVER" "sudo systemctl daemon-reload && sudo systemctl enable tonight-play-time && sudo systemctl restart tonight-play-time"

echo "⏳ Waiting for service to start..."
sleep 3

echo "🔍 Checking service status..."
ssh "$DEPLOY_SERVER" "sudo systemctl status tonight-play-time --no-pager"

echo ""
echo "✅ Deployment complete!"
echo "🌐 API endpoint: http://100.81.234.57:8001"
echo "🔗 Health check: http://100.81.234.57:8001/api/health"
