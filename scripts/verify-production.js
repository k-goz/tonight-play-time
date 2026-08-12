const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const databasePath = path.resolve(
  process.env.DATABASE_PATH || path.join(__dirname, '..', 'backend', 'data', 'tonight_play_time.db')
);
if (!fs.existsSync(databasePath)) throw new Error(`数据库不存在：${databasePath}`);
const database = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);

database.get('PRAGMA integrity_check', (integrityError, integrity) => {
  if (integrityError) throw integrityError;
  database.get('PRAGMA user_version', (versionError, version) => {
    database.close();
    if (versionError) throw versionError;
    const result = {
      database: databasePath,
      integrity: Object.values(integrity || {})[0],
      schemaVersion: version.user_version,
      passed: Object.values(integrity || {})[0] === 'ok' && version.user_version >= 5
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.passed) process.exitCode = 1;
  });
});
