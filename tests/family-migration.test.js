const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();

function execSql(database, sql) {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => error ? reject(error) : resolve());
  });
}

test('legacy single-child database migrates records into a default child profile', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonight-family-migration-'));
  const databasePath = path.join(directory, 'legacy.db');
  const database = new sqlite3.Database(databasePath);

  await execSql(database, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      pin_code TEXT DEFAULT '1234',
      bedtime TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE homework_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      homework_minutes REAL DEFAULT 0,
      total_minutes REAL DEFAULT 0,
      start_time TEXT,
      end_time TEXT,
      completed BOOLEAN DEFAULT 0,
      homework_done BOOLEAN DEFAULT 0,
      correction_done BOOLEAN DEFAULT 0,
      attitude_good BOOLEAN DEFAULT 0,
      playtime_type TEXT,
      playtime_minutes REAL DEFAULT 0,
      bedtime TEXT DEFAULT '21:30',
      state TEXT DEFAULT 'idle',
      homework_seconds REAL DEFAULT 0,
      paused_seconds REAL DEFAULT 0,
      remaining_seconds REAL DEFAULT 0,
      reward_choice TEXT,
      title TEXT,
      call_it_a_day BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, date)
    );
    INSERT INTO users (id, username, nickname, password_hash, bedtime)
      VALUES (1, 'legacy_family', '老大', 'legacy-hash', '22:10');
    INSERT INTO homework_sessions (
      id, user_id, date, completed, state, homework_seconds, bedtime, title
    ) VALUES (7, 1, '2026-08-01', 1, 'completed', 900, '22:10', '历史记录');
  `);
  await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

  const inspectionScript = `
    const { db, databaseReady } = require('./backend/server');
    databaseReady.then(() => {
      db.get('SELECT * FROM child_profiles WHERE user_id = 1', (childError, child) => {
        if (childError) throw childError;
        db.get('SELECT * FROM homework_sessions WHERE id = 7', (sessionError, session) => {
          if (sessionError) throw sessionError;
          db.get('PRAGMA user_version', (versionError, version) => {
            if (versionError) throw versionError;
            db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parent_grants'", (grantError, grantTable) => {
              if (grantError) throw grantError;
              process.stdout.write(JSON.stringify({ child, session, grantTable, version: version.user_version }));
              db.close();
            });
          });
        });
      });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', inspectionScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.grantTable.name, 'parent_grants');
  assert.equal(migrated.child.name, '老大');
  assert.equal(migrated.child.bedtime, '22:10');
  assert.equal(migrated.child.weekend_bedtime, '22:10');
  assert.equal(migrated.child.archived_at, null);
  assert.equal(migrated.child.reminder_time, '19:00');
  assert.equal(migrated.child.weekend_reminder_time, '19:00');
  assert.equal(migrated.child.weekly_goal, 5);
  assert.equal(migrated.child.is_default, 1);
  assert.equal(migrated.session.child_id, migrated.child.id);
  assert.equal(migrated.session.homework_seconds, 900);
  assert.equal(migrated.session.title, '历史记录');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('V2 family database gains weekend rules and archive state without losing history', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonight-rules-migration-'));
  const databasePath = path.join(directory, 'family-v2.db');
  const database = new sqlite3.Database(databasePath);

  await execSql(database, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      pin_code TEXT,
      parent_pin_hash TEXT,
      bedtime TEXT,
      settings_initialized BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE child_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🌙',
      bedtime TEXT NOT NULL DEFAULT '21:30',
      is_default BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE homework_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      child_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      homework_minutes REAL DEFAULT 0,
      total_minutes REAL DEFAULT 0,
      start_time TEXT,
      end_time TEXT,
      completed BOOLEAN DEFAULT 0,
      homework_done BOOLEAN DEFAULT 0,
      correction_done BOOLEAN DEFAULT 0,
      attitude_good BOOLEAN DEFAULT 0,
      playtime_type TEXT,
      playtime_minutes REAL DEFAULT 0,
      bedtime TEXT DEFAULT '21:30',
      state TEXT DEFAULT 'idle',
      homework_seconds REAL DEFAULT 0,
      paused_seconds REAL DEFAULT 0,
      remaining_seconds REAL DEFAULT 0,
      reward_choice TEXT,
      title TEXT,
      call_it_a_day BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, child_id, date)
    );
    INSERT INTO users (id, username, nickname, password_hash, bedtime, settings_initialized)
      VALUES (1, 'family_v2', '家庭', 'hash', '21:40', 1);
    INSERT INTO child_profiles (id, user_id, name, bedtime, is_default)
      VALUES (5, 1, '小朋友', '20:50', 1);
    INSERT INTO homework_sessions (
      id, user_id, child_id, date, completed, state, homework_seconds, title
    ) VALUES (9, 1, 5, '2026-08-02', 1, 'completed', 1200, '保留记录');
    PRAGMA user_version = 2;
  `);
  await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

  const inspectionScript = `
    const { db, databaseReady } = require('./backend/server');
    databaseReady.then(() => {
      db.get('SELECT * FROM child_profiles WHERE id = 5', (childError, child) => {
        if (childError) throw childError;
        db.get('SELECT * FROM homework_sessions WHERE id = 9', (sessionError, session) => {
          if (sessionError) throw sessionError;
          db.get('PRAGMA user_version', (versionError, version) => {
            if (versionError) throw versionError;
            db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parent_grants'", (grantError, grantTable) => {
              if (grantError) throw grantError;
              process.stdout.write(JSON.stringify({ child, session, grantTable, version: version.user_version }));
              db.close();
            });
          });
        });
      });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', inspectionScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.grantTable.name, 'parent_grants');
  assert.equal(migrated.child.weekend_bedtime, '20:50');
  assert.equal(migrated.child.archived_at, null);
  assert.equal(migrated.session.version, 1);
  assert.equal(migrated.session.child_id, 5);
  assert.equal(migrated.session.homework_seconds, 1200);
  assert.equal(migrated.session.title, '保留记录');

  fs.rmSync(directory, { recursive: true, force: true });
});

test('V3 family rules database upgrades to scoped parent grants', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonight-parent-migration-'));
  const databasePath = path.join(directory, 'family-v3.db');
  const database = new sqlite3.Database(databasePath);

  await execSql(database, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      pin_code TEXT,
      parent_pin_hash TEXT,
      bedtime TEXT,
      settings_initialized BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE child_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🌙',
      bedtime TEXT NOT NULL DEFAULT '21:30',
      weekend_bedtime TEXT NOT NULL DEFAULT '21:30',
      is_default BOOLEAN NOT NULL DEFAULT 0,
      archived_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE homework_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      child_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      bedtime TEXT DEFAULT '21:30',
      state TEXT DEFAULT 'idle',
      homework_seconds REAL DEFAULT 0,
      paused_seconds REAL DEFAULT 0,
      remaining_seconds REAL DEFAULT 0,
      reward_choice TEXT,
      title TEXT,
      call_it_a_day BOOLEAN DEFAULT 0,
      UNIQUE (user_id, child_id, date)
    );
    INSERT INTO users (id, username, nickname, password_hash, bedtime, settings_initialized)
      VALUES (1, 'family_v3', '家庭', 'hash', '21:30', 1);
    INSERT INTO child_profiles (
      id, user_id, name, bedtime, weekend_bedtime, is_default
    ) VALUES (3, 1, '小朋友', '21:00', '22:00', 1);
    INSERT INTO homework_sessions (id, user_id, child_id, date, state, homework_seconds)
      VALUES (6, 1, 3, '2026-08-03', 'paused', 600);
    PRAGMA user_version = 3;
  `);
  await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

  const inspectionScript = `
    const { db, databaseReady } = require('./backend/server');
    databaseReady.then(() => {
      db.get('SELECT * FROM child_profiles WHERE id = 3', (childError, child) => {
        if (childError) throw childError;
        db.get('SELECT * FROM homework_sessions WHERE id = 6', (sessionError, session) => {
          if (sessionError) throw sessionError;
          db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parent_grants'", (grantError, grantTable) => {
            if (grantError) throw grantError;
            db.get('PRAGMA user_version', (versionError, version) => {
              if (versionError) throw versionError;
              process.stdout.write(JSON.stringify({ child, session, grantTable, version: version.user_version }));
              db.close();
            });
          });
        });
      });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', inspectionScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.grantTable.name, 'parent_grants');
  assert.equal(migrated.child.weekend_bedtime, '22:00');
  assert.equal(migrated.session.homework_seconds, 600);
  assert.equal(migrated.session.version, 1);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('V4 parent access database upgrades to the family platform schema', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonight-platform-migration-'));
  const databasePath = path.join(directory, 'family-v4.db');
  const database = new sqlite3.Database(databasePath);
  await execSql(database, `
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL, password_hash TEXT NOT NULL, pin_code TEXT,
      parent_pin_hash TEXT, bedtime TEXT, settings_initialized BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE child_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🌙', bedtime TEXT NOT NULL DEFAULT '21:30',
      weekend_bedtime TEXT NOT NULL DEFAULT '21:30', is_default BOOLEAN NOT NULL DEFAULT 0,
      archived_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE homework_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, child_id INTEGER NOT NULL,
      date TEXT NOT NULL, homework_minutes REAL DEFAULT 0, total_minutes REAL DEFAULT 0,
      start_time TEXT, end_time TEXT, completed BOOLEAN DEFAULT 0, homework_done BOOLEAN DEFAULT 0,
      correction_done BOOLEAN DEFAULT 0, attitude_good BOOLEAN DEFAULT 0, playtime_type TEXT,
      playtime_minutes REAL DEFAULT 0, bedtime TEXT DEFAULT '21:30', state TEXT DEFAULT 'idle',
      homework_seconds REAL DEFAULT 0, paused_seconds REAL DEFAULT 0, remaining_seconds REAL DEFAULT 0,
      reward_choice TEXT, title TEXT, call_it_a_day BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, child_id, date)
    );
    CREATE TABLE parent_grants (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, scope TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, username, nickname, password_hash) VALUES (1, 'family_v4', '家庭', 'hash');
    INSERT INTO child_profiles (id, user_id, name, is_default) VALUES (4, 1, '小朋友', 1);
    INSERT INTO homework_sessions (id, user_id, child_id, date, state) VALUES (8, 1, 4, '2026-08-04', 'running');
    PRAGMA user_version = 4;
  `);
  await new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));

  const inspectionScript = `
    const { db, databaseReady } = require('./backend/server');
    databaseReady.then(() => {
      db.get('SELECT * FROM child_profiles WHERE id = 4', (childError, child) => {
        if (childError) throw childError;
        db.get('SELECT * FROM homework_sessions WHERE id = 8', (sessionError, session) => {
          if (sessionError) throw sessionError;
          db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('family_preferences','sync_conflicts','audit_logs','product_events') ORDER BY name", (tableError, tables) => {
            if (tableError) throw tableError;
            db.get('PRAGMA user_version', (versionError, version) => {
              if (versionError) throw versionError;
              process.stdout.write(JSON.stringify({ child, session, tables, version: version.user_version }));
              db.close();
            });
          });
        });
      });
    }).catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', inspectionScript], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, DATABASE_PATH: databasePath },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  const migrated = JSON.parse(result.stdout);
  assert.equal(migrated.version, 5);
  assert.equal(migrated.child.reminder_enabled, 0);
  assert.equal(migrated.child.weekly_goal, 5);
  assert.equal(migrated.session.version, 1);
  assert.deepEqual(migrated.tables.map(table => table.name), [
    'audit_logs', 'family_preferences', 'product_events', 'sync_conflicts'
  ]);
  fs.rmSync(directory, { recursive: true, force: true });
});
