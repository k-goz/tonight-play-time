# MacBook8 部署指南

## 快速部署（一键脚本）

SSH 到 MacBook8 后执行：

```bash
# 1. 进入项目目录
cd /opt/tonight-play-time

# 2. 安装依赖
cd backend && npm install --production

# 3. 启动服务
node server.js
```

## 生产环境部署（systemd 服务）

```bash
# 1. 创建 systemd 服务文件
sudo tee /etc/systemd/system/tonight-play-time.service > /dev/null << 'EOF'
[Unit]
Description=Tonight Play Time API
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/tonight-play-time/backend
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

# 2. 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable tonight-play-time
sudo systemctl start tonight-play-time

# 3. 查看状态
sudo systemctl status tonight-play-time

# 4. 查看日志
sudo journalctl -u tonight-play-time -f
```

## 访问方式

- **本地访问**: http://localhost:8001
- **Tailscale 访问**: http://100.81.234.57:8001
- **健康检查**: http://100.81.234.57:8001/api/health

## 功能说明

### 账号系统
- **注册**: 用户名 + 昵称 + 密码
- **登录**: 用户名 + 密码
- **数据同步**: 登录后数据自动同步到服务器
- **离线模式**: 可选择跳过登录，使用本地存储

### 数据持久化
- 用户数据存储在 SQLite 数据库: `/opt/tonight-play-time/backend/tonight_play_time.db`
- 支持多用户
- 数据不会因清空浏览器缓存而丢失

### 分享给朋友
1. 朋友通过 Tailscale 访问 http://100.81.234.57:8001
2. 注册账号
3. 开始使用

## 前端访问

### 方式一：通过后端访问（推荐）
访问 http://100.81.234.57:8001 即可，后端会自动提供前端文件

### 方式二：GitHub Pages
访问 https://k-goz.github.io/tonight-play-time/
- 需要手动配置 API 地址
- 或者使用本地模式（数据只存在浏览器）

## 故障排查

### 服务无法启动
```bash
# 检查端口占用
sudo ss -tlnp | grep 8001

# 检查日志
sudo journalctl -u tonight-play-time -n 50

# 重启服务
sudo systemctl restart tonight-play-time
```

### 数据库问题
```bash
# 删除数据库重新开始（会丢失数据）
rm /opt/tonight-play-time/backend/tonight_play_time.db
sudo systemctl restart tonight-play-time
```

### 网络问题
```bash
# 检查 Tailscale 状态
tailscale status

# 检查防火墙
sudo iptables -L -n | grep 8001
```
