const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'backend', 'data', 'tonight_play_time.db')
);
const backupDirectory = path.resolve(
  process.env.BACKUP_DIR || path.join(path.dirname(databasePath), 'backups')
);
const retention = Math.min(Math.max(Number(process.env.BACKUP_RETENTION) || 14, 1), 100);

if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
  throw new Error(`数据库不存在：${databasePath}`);
}
fs.mkdirSync(backupDirectory, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDirectory, `tonight-play-time-${timestamp}.db`);
const escapedBackupPath = backupPath.replace(/'/g, "''");
const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READWRITE);

database.get('PRAGMA integrity_check', (integrityError, row) => {
  if (integrityError || Object.values(row || {})[0] !== 'ok') {
    database.close();
    throw integrityError || new Error('源数据库完整性检查失败，已停止备份');
  }
  database.run(`VACUUM INTO '${escapedBackupPath}'`, (backupError) => {
    database.close();
    if (backupError) throw backupError;
    const backups = fs.readdirSync(backupDirectory)
      .filter(name => /^tonight-play-time-.*\.db$/.test(name))
      .sort()
      .reverse();
    backups.slice(retention).forEach(name => fs.unlinkSync(path.join(backupDirectory, name)));
    process.stdout.write(`${backupPath}\n`);
  });
});
