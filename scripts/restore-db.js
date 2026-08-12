const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const backupArgument = process.argv[2];
const confirmed = process.argv.includes('--confirm');
if (!backupArgument || !confirmed) {
  throw new Error('用法：npm run db:restore -- /绝对路径/backup.db --confirm');
}

const backupPath = path.resolve(backupArgument);
const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'backend', 'data', 'tonight_play_time.db')
);
if (backupPath === databasePath) throw new Error('备份源与数据库目标不能相同');
if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) throw new Error('备份文件不存在');
const header = fs.readFileSync(backupPath).subarray(0, 16).toString('utf8');
if (header !== 'SQLite format 3\u0000') throw new Error('备份文件不是有效的 SQLite 数据库');

const backupDatabase = new sqlite3.Database(backupPath, sqlite3.OPEN_READONLY);
backupDatabase.get('PRAGMA integrity_check', (error, row) => {
  backupDatabase.close();
  if (error || Object.values(row || {})[0] !== 'ok') throw error || new Error('备份完整性检查失败');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  if (fs.existsSync(databasePath)) {
    const safetyCopy = `${databasePath}.pre-restore-${Date.now()}.bak`;
    fs.copyFileSync(databasePath, safetyCopy, fs.constants.COPYFILE_EXCL);
    process.stdout.write(`恢复前副本：${safetyCopy}\n`);
  }
  fs.copyFileSync(backupPath, databasePath);
  process.stdout.write(`已恢复：${databasePath}\n`);
});
