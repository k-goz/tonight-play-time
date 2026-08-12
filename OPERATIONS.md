# 运行与恢复手册

## 日常检查

```bash
curl -f https://your-domain.example/api/health
npm run quality
DATABASE_PATH=/absolute/path/app.db npm run verify:production
```

家长控制台的“运行”区会显示数据库完整性、Schema 版本、待处理同步冲突、可见备份和最近审计行为。

## 备份

```bash
DATABASE_PATH=/absolute/path/app.db \
BACKUP_DIR=/absolute/path/backups \
BACKUP_RETENTION=14 \
npm run db:backup
```

脚本先执行 `PRAGMA integrity_check`，再用 SQLite `VACUUM INTO` 生成一致性快照。默认保留最近 14 份，范围可设为 1-100。

## 恢复演练

1. 停止应用，确认没有进程继续写数据库。
2. 在隔离路径先恢复并执行 `npm run verify:production`。
3. 正式恢复时使用 `--confirm`；脚本会先保存一个带时间戳的 `.pre-restore-*.bak` 副本。
4. 启动服务，检查 `/api/health`、登录、家庭成员、当日记录和家长模式。

```bash
DATABASE_PATH=/absolute/path/restored.db \
npm run db:restore -- /absolute/path/backups/backup.db --confirm

DATABASE_PATH=/absolute/path/restored.db npm run verify:production
```

## 发布门禁

- `npm run quality` 全绿，依赖审计为 0 个已知漏洞
- SQLite 备份成功，隔离恢复成功，Schema 为 V5
- HTTPS、持久化磁盘、磁盘容量告警和备份失败告警已配置
- iOS Safari / Android Chrome 安装、离线、通知拒绝降级和恢复联网均验证
- 旧版本先灰度；出现迁移或同步异常时停止写入并恢复发布前快照

## 已知边界

- 当前接口限流保存在单个 Node 进程内；多实例部署应迁移到共享限流存储。
- 提醒 V1 由正在运行的 PWA 本地调度；完全关闭应用后的远程通知需要 Web Push 服务。
- 家庭版目前只记录试用和价格意向，不接支付、不自动续费。
