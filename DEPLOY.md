# 部署指南

当前唯一受支持的运行时是 Node.js 20.17+、Express 和 SQLite。

## Railway

仓库根目录的 `railway.json` 使用：

```text
node backend/server.js
```

需要挂载持久化 Volume。应用会优先把数据库写入 `RAILWAY_VOLUME_MOUNT_PATH`。部署后验证：

```bash
curl -f https://your-domain.example/api/health
```

## 自有 Linux 主机

建议使用独立的低权限系统用户和 SSH Key：

```bash
cd /opt/tonight-play-time
npm install --omit=dev
npm start
```

systemd 示例：

```ini
[Unit]
Description=Tonight Play Time
After=network.target

[Service]
Type=simple
User=tonight-play-time
WorkingDirectory=/opt/tonight-play-time
ExecStart=/usr/bin/node backend/server.js
Environment=NODE_ENV=production
Environment=PORT=8001
Environment=DATABASE_PATH=/var/lib/tonight-play-time/app.db
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

反向代理必须启用 HTTPS，并且只暴露应用端口，不要额外发布项目目录或数据库目录。

## 部署脚本

`deploy.sh` 不保存密码，使用当前 SSH Agent 或指定的 SSH Key：

```bash
DEPLOY_SERVER=user@host ./deploy.sh
```

可通过 `DEPLOY_REMOTE_DIR` 修改远端目录。

## 上线前检查

```bash
npm run check
npm test
npm audit --omit=dev
```

还必须确认：

- 旧版脚本中曾出现过的服务器凭据已经轮换。
- SQLite 所在目录不可被 Web 服务读取。
- 升级前已备份 SQLite；启动时会自动补充账号设置与 PIN 哈希字段。
- 已配置定期数据库备份与恢复演练。
- 健康检查、服务重启和 HTTPS 均正常。
