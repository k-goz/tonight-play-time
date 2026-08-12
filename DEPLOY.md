# 部署指南

生产运行时是 Node.js 24 LTS、Express、Vercel Functions 和托管 PostgreSQL；本地及
Railway 持久卷继续支持 SQLite。

## Vercel + Neon（生产推荐）

仓库包含 `api/index.js` 和 `vercel.json`：静态 PWA 由 Vercel CDN 提供，
`/api/*` 同源改写到 Express Function。数据库连接来自 Vercel Marketplace Neon，
生产、预览和开发环境均通过加密环境变量注入，仓库不保存连接串。

```bash
vercel link --yes --project tonight-play-time --scope k-gozs-projects
vercel env pull .env.local --environment=development --yes
npm run quality:cloud
vercel deploy
```

预览通过后推送 `main`，Git 集成会自动生产发布。生产验收：

```bash
curl -f https://tonight-play-time.vercel.app/api/health
vercel inspect https://tonight-play-time.vercel.app
```

旧 SQLite 数据迁移：

```bash
npm run db:migrate:postgres -- /absolute/path/tonight_play_time.db --confirm
npm run db:verify:postgres
```

迁移脚本可接受 V1-V5 SQLite；旧版本先原地升级到 V5，再在单个 PostgreSQL
事务中导入，已存在的主键或唯一键不会被覆盖。

## Railway + SQLite（兼容）

仓库根目录的 `railway.json` 使用：

```text
node backend/server.js
```

需要挂载持久化 Volume。应用会优先把数据库写入 `RAILWAY_VOLUME_MOUNT_PATH`。部署后验证：

```bash
curl -f https://your-domain.example/api/health
```

## 自有 Linux 主机 + SQLite（兼容）

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
npm run db:backup
npm run verify:production
```

还必须确认：

- 旧版脚本中曾出现过的服务器凭据已经轮换。
- SQLite 所在目录不可被 Web 服务读取。
- 升级前已备份 SQLite；启动时会自动升级到 V5：保留历史和家长授权，并新增提醒、成长、冲突、审计与产品验证结构。
- 部署后已验证家长模式授权、主动锁定、完成确认令牌和敏感接口 `403` 边界。
- 已配置定期数据库备份与恢复演练。
- 健康检查、服务重启和 HTTPS 均正常。
- 已在实际 iOS Safari PWA 与 Android Chrome PWA 完成安装、通知降级、离线计时和重新登录测试。

建议通过 cron 每天执行：

```cron
15 3 * * * cd /opt/tonight-play-time && DATABASE_PATH=/var/lib/tonight-play-time/app.db BACKUP_RETENTION=14 npm run db:backup >> /var/log/tonight-play-time-backup.log 2>&1
```

恢复前必须停止应用，并显式指定备份：

```bash
sudo systemctl stop tonight-play-time
DATABASE_PATH=/var/lib/tonight-play-time/app.db npm run db:restore -- /absolute/path/backup.db --confirm
DATABASE_PATH=/var/lib/tonight-play-time/app.db npm run verify:production
sudo systemctl start tonight-play-time
```

完整操作说明见 [OPERATIONS.md](OPERATIONS.md)。
