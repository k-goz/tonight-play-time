const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 8001;
const APP_ROOT = path.resolve(__dirname, '..');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY'
  });
  next();
});

// Keep user data outside the web root. Railway volumes and explicit DATABASE_PATH
// take precedence; local development defaults to backend/data/.
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'tonight_play_time.db')
  : path.resolve(process.env.DATABASE_PATH || path.join(__dirname, 'data', 'tonight_play_time.db'));
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new sqlite3.Database(dbPath);
db.configure('busyTimeout', 5000);

function addColumn(table, column, definition) {
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, (error) => {
    if (error && !/duplicate column name/i.test(error.message)) {
      console.error(`Failed to add ${table}.${column}:`, error.message);
    }
  });
}

const PLATFORM_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS family_preferences (
    user_id INTEGER PRIMARY KEY,
    allow_child_switch BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS weekly_rewards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL,
    week_start TEXT NOT NULL,
    reward_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'approved', 'redeemed')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id) REFERENCES child_profiles(id) ON DELETE CASCADE,
    UNIQUE (user_id, child_id, week_start)
  );
  CREATE TABLE IF NOT EXISTS streak_protections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL,
    protected_date TEXT NOT NULL,
    week_start TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id) REFERENCES child_profiles(id) ON DELETE CASCADE,
    UNIQUE (user_id, child_id, protected_date)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_streak_protections_week
    ON streak_protections(user_id, child_id, week_start);
  CREATE TABLE IF NOT EXISTS reminder_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL,
    detail TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id) REFERENCES child_profiles(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_reminder_events_child
    ON reminder_events(user_id, child_id, created_at);
  CREATE TABLE IF NOT EXISTS sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL,
    session_id INTEGER NOT NULL,
    device_id TEXT,
    base_version INTEGER NOT NULL,
    server_version INTEGER NOT NULL,
    client_payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'resolved_server', 'resolved_client')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (child_id) REFERENCES child_profiles(id) ON DELETE CASCADE,
    FOREIGN KEY (session_id) REFERENCES homework_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sync_conflicts_user
    ON sync_conflicts(user_id, status, created_at);
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_logs_user
    ON audit_logs(user_id, created_at);
  CREATE TABLE IF NOT EXISTS product_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    plan_code TEXT,
    price_point INTEGER,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_product_events_user
    ON product_events(user_id, event_type, created_at);
`;

function migrateToPlatformSchema(resolve, reject) {
  db.all('PRAGMA table_info(child_profiles)', (childError, childColumns = []) => {
    if (childError) return reject(childError);
    db.all('PRAGMA table_info(homework_sessions)', (sessionError, sessionColumns = []) => {
      if (sessionError) return reject(sessionError);
      db.all('PRAGMA table_info(users)', (userError, userColumns = []) => {
        if (userError) return reject(userError);
        const childNames = new Set(childColumns.map(column => column.name));
        const sessionNames = new Set(sessionColumns.map(column => column.name));
        const userNames = new Set(userColumns.map(column => column.name));
        const statements = [];
        if (!childNames.has('reminder_enabled')) {
          statements.push('ALTER TABLE child_profiles ADD COLUMN reminder_enabled BOOLEAN NOT NULL DEFAULT 0');
        }
        if (!childNames.has('reminder_time')) {
          statements.push("ALTER TABLE child_profiles ADD COLUMN reminder_time TEXT NOT NULL DEFAULT '19:00'");
        }
        if (!childNames.has('weekend_reminder_time')) {
          statements.push("ALTER TABLE child_profiles ADD COLUMN weekend_reminder_time TEXT NOT NULL DEFAULT '19:00'");
        }
        if (!childNames.has('pause_reminder_minutes')) {
          statements.push('ALTER TABLE child_profiles ADD COLUMN pause_reminder_minutes INTEGER NOT NULL DEFAULT 30');
        }
        if (!childNames.has('weekly_goal')) {
          statements.push('ALTER TABLE child_profiles ADD COLUMN weekly_goal INTEGER NOT NULL DEFAULT 5');
        }
        if (!childNames.has('reward_text')) {
          statements.push("ALTER TABLE child_profiles ADD COLUMN reward_text TEXT NOT NULL DEFAULT '周末一起选一个亲子活动'");
        }
        if (!sessionNames.has('version')) {
          statements.push('ALTER TABLE homework_sessions ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
        }
        if (!userNames.has('plan_tier')) {
          statements.push("ALTER TABLE users ADD COLUMN plan_tier TEXT NOT NULL DEFAULT 'free'");
        }
        if (!userNames.has('trial_started_at')) {
          statements.push('ALTER TABLE users ADD COLUMN trial_started_at DATETIME');
        }
        statements.push(PLATFORM_TABLES_SQL);
        statements.push('PRAGMA user_version = 5');

        db.exec(`BEGIN IMMEDIATE; ${statements.join('; ')}; COMMIT;`, (error) => {
          if (!error) return resolve();
          db.run('ROLLBACK', () => reject(error));
        });
      });
    });
  });
}

function migrateToFamilySchema(resolve, reject) {
  const migrationSql = `
    BEGIN IMMEDIATE;

    CREATE TABLE IF NOT EXISTS child_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '🌙',
      bedtime TEXT NOT NULL DEFAULT '21:30',
      weekend_bedtime TEXT NOT NULL DEFAULT '21:30',
      is_default BOOLEAN NOT NULL DEFAULT 0,
      archived_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    INSERT INTO child_profiles (user_id, name, bedtime, weekend_bedtime, is_default)
    SELECT users.id, users.nickname, COALESCE(users.bedtime, '21:30'),
      COALESCE(users.bedtime, '21:30'), 1
    FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM child_profiles WHERE child_profiles.user_id = users.id
    );

    UPDATE child_profiles
    SET is_default = 0
    WHERE is_default = 1 AND id NOT IN (
      SELECT MIN(id) FROM child_profiles WHERE is_default = 1 GROUP BY user_id
    );

    UPDATE child_profiles
    SET is_default = 1
    WHERE id IN (
      SELECT MIN(id) FROM child_profiles
      GROUP BY user_id
      HAVING MAX(is_default) = 0
    );

    DROP TABLE IF EXISTS homework_sessions_family;
    CREATE TABLE homework_sessions_family (
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
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (child_id) REFERENCES child_profiles(id) ON DELETE CASCADE,
      UNIQUE (user_id, child_id, date)
    );

    INSERT INTO homework_sessions_family (
      id, user_id, child_id, date, homework_minutes, total_minutes,
      start_time, end_time, completed, homework_done, correction_done,
      attitude_good, playtime_type, playtime_minutes, bedtime, state,
      homework_seconds, paused_seconds, remaining_seconds, reward_choice,
      title, call_it_a_day, created_at, updated_at
    )
    SELECT
      sessions.id, sessions.user_id, children.id, sessions.date,
      sessions.homework_minutes, sessions.total_minutes, sessions.start_time,
      sessions.end_time, sessions.completed, sessions.homework_done,
      sessions.correction_done, sessions.attitude_good, sessions.playtime_type,
      sessions.playtime_minutes, sessions.bedtime, sessions.state,
      sessions.homework_seconds, sessions.paused_seconds,
      sessions.remaining_seconds, sessions.reward_choice, sessions.title,
      sessions.call_it_a_day, sessions.created_at, sessions.updated_at
    FROM homework_sessions sessions
    JOIN child_profiles children
      ON children.user_id = sessions.user_id AND children.is_default = 1;

    DROP TABLE homework_sessions;
    ALTER TABLE homework_sessions_family RENAME TO homework_sessions;
    CREATE INDEX IF NOT EXISTS idx_sessions_user_child
      ON homework_sessions(user_id, child_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_child_profiles_one_default
      ON child_profiles(user_id) WHERE is_default = 1;
    CREATE INDEX IF NOT EXISTS idx_child_profiles_user
      ON child_profiles(user_id);
    CREATE TABLE IF NOT EXISTS parent_grants (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('manage', 'approve')),
      expires_at INTEGER NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_parent_grants_user
      ON parent_grants(user_id);
    PRAGMA user_version = 4;
    COMMIT;
  `;

  db.exec(migrationSql, (error) => {
    if (!error) return migrateToPlatformSchema(resolve, reject);
    db.run('ROLLBACK', () => reject(error));
  });
}

function migrateToRulesSchema(resolve, reject) {
  db.all('PRAGMA table_info(child_profiles)', (columnError, columns = []) => {
    if (columnError) return reject(columnError);
    const names = new Set(columns.map(column => column.name));
    const statements = [];
    const addsWeekendBedtime = !names.has('weekend_bedtime');
    if (addsWeekendBedtime) {
      statements.push("ALTER TABLE child_profiles ADD COLUMN weekend_bedtime TEXT NOT NULL DEFAULT '21:30'");
    }
    if (!names.has('archived_at')) {
      statements.push('ALTER TABLE child_profiles ADD COLUMN archived_at DATETIME');
    }
    statements.push(`UPDATE child_profiles
      SET weekend_bedtime = bedtime
      ${addsWeekendBedtime ? '' : "WHERE weekend_bedtime IS NULL OR weekend_bedtime = ''"}`);
    statements.push(`CREATE TABLE IF NOT EXISTS parent_grants (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('manage', 'approve')),
      expires_at INTEGER NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    statements.push('CREATE INDEX IF NOT EXISTS idx_parent_grants_user ON parent_grants(user_id)');
    statements.push('PRAGMA user_version = 4');

    db.exec(`BEGIN IMMEDIATE; ${statements.join('; ')}; COMMIT;`, (error) => {
      if (!error) return migrateToPlatformSchema(resolve, reject);
      db.run('ROLLBACK', () => reject(error));
    });
  });
}

function migrateToParentAccessSchema(resolve, reject) {
  db.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS parent_grants (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('manage', 'approve')),
      expires_at INTEGER NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_parent_grants_user
      ON parent_grants(user_id);
    PRAGMA user_version = 4;
    COMMIT;
  `, (error) => {
    if (!error) return migrateToPlatformSchema(resolve, reject);
    db.run('ROLLBACK', () => reject(error));
  });
}

const databaseReady = new Promise((resolve, reject) => {
  db.serialize(() => {
    db.run('PRAGMA foreign_keys = ON');
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      pin_code TEXT DEFAULT '1234',
      parent_pin_hash TEXT,
      bedtime TEXT,
      settings_initialized BOOLEAN NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    addColumn('users', 'parent_pin_hash', 'TEXT');
    addColumn('users', 'bedtime', 'TEXT');
    addColumn('users', 'settings_initialized', 'BOOLEAN NOT NULL DEFAULT 0');
    db.run('UPDATE users SET settings_initialized = 1 WHERE bedtime IS NOT NULL');

    db.run(`CREATE TABLE IF NOT EXISTS homework_sessions (
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
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE (user_id, date)
    )`);

    // Forward-only compatibility for databases created by the original MVP.
    addColumn('homework_sessions', 'state', "TEXT DEFAULT 'idle'");
    addColumn('homework_sessions', 'homework_seconds', 'REAL DEFAULT 0');
    addColumn('homework_sessions', 'paused_seconds', 'REAL DEFAULT 0');
    addColumn('homework_sessions', 'remaining_seconds', 'REAL DEFAULT 0');
    addColumn('homework_sessions', 'reward_choice', 'TEXT');
    addColumn('homework_sessions', 'title', 'TEXT');
    addColumn('homework_sessions', 'call_it_a_day', 'BOOLEAN DEFAULT 0');

    db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    db.run('CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id)');

    db.get('PRAGMA user_version', (error, row) => {
      if (error) return reject(error);
      if ((row?.user_version || 0) < 2) return migrateToFamilySchema(resolve, reject);
      if ((row?.user_version || 0) < 3) return migrateToRulesSchema(resolve, reject);
      if ((row?.user_version || 0) < 4) return migrateToParentAccessSchema(resolve, reject);
      if ((row?.user_version || 0) < 5) return migrateToPlatformSchema(resolve, reject);

      db.exec(`
        CREATE TABLE IF NOT EXISTS child_profiles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          avatar TEXT NOT NULL DEFAULT '🌙',
          bedtime TEXT NOT NULL DEFAULT '21:30',
          weekend_bedtime TEXT NOT NULL DEFAULT '21:30',
          is_default BOOLEAN NOT NULL DEFAULT 0,
          archived_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_child_profiles_one_default
          ON child_profiles(user_id) WHERE is_default = 1;
        CREATE INDEX IF NOT EXISTS idx_child_profiles_user
          ON child_profiles(user_id);
        CREATE INDEX IF NOT EXISTS idx_sessions_user_child
          ON homework_sessions(user_id, child_id);
        CREATE TABLE IF NOT EXISTS parent_grants (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('manage', 'approve')),
          expires_at INTEGER NOT NULL,
          used_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_parent_grants_user
          ON parent_grants(user_id);
        ${PLATFORM_TABLES_SQL}
      `, (schemaError) => schemaError ? reject(schemaError) : resolve());
    });
  });
});

app.use((req, res, next) => {
  databaseReady.then(() => next()).catch((error) => {
    console.error('Database initialization failed:', error);
    res.status(503).json({ detail: '数据库初始化失败' });
  });
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  if (typeof storedHash !== 'string') return false;

  if (storedHash.startsWith('scrypt$')) {
    const [, salt, expectedHex] = storedHash.split('$');
    if (!salt || !expectedHex) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(expectedHex, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  // One-time compatibility with the original unsalted SHA-256 hashes.
  const legacyHash = crypto.createHash('sha256').update(password).digest('hex');
  const actual = Buffer.from(legacyHash, 'hex');
  const expected = Buffer.from(storedHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function createToken(userId, callback) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  db.run(
    'INSERT INTO auth_tokens (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [tokenHash, userId, expiresAt],
    (error) => callback(error, token)
  );
}

const PARENT_GRANT_TTL = {
  manage: 15 * 60 * 1000,
  approve: 5 * 60 * 1000
};

function createParentGrant(userId, scope, callback) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = Date.now() + PARENT_GRANT_TTL[scope];
  db.run(
    'DELETE FROM parent_grants WHERE user_id = ? AND (expires_at <= ? OR used_at IS NOT NULL)',
    [userId, Date.now()],
    (cleanupError) => {
      if (cleanupError) return callback(cleanupError);
      db.run(
        `INSERT INTO parent_grants (token_hash, user_id, scope, expires_at)
         VALUES (?, ?, ?, ?)`,
        [tokenHash, userId, scope, expiresAt],
        (error) => callback(error, { token, expiresAt })
      );
    }
  );
}

function verifyParentGrant(req, headerName, scope, consume, callback) {
  const rawToken = req.headers[headerName] || '';
  if (!/^[a-f0-9]{64}$/i.test(rawToken)) return callback(null, false);
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  db.get(
    `SELECT token_hash FROM parent_grants
     WHERE token_hash = ? AND user_id = ? AND scope = ?
       AND expires_at > ? AND used_at IS NULL`,
    [tokenHash, req.userId, scope, Date.now()],
    (error, grant) => {
      if (error || !grant) return callback(error, false);
      if (!consume) {
        req.parentTokenHash = tokenHash;
        return callback(null, true);
      }
      db.run(
        `UPDATE parent_grants SET used_at = CURRENT_TIMESTAMP
         WHERE token_hash = ? AND user_id = ? AND used_at IS NULL`,
        [tokenHash, req.userId],
        function onConsume(updateError) {
          callback(updateError, !updateError && this.changes === 1);
        }
      );
    }
  );
}

function parentAuth(req, res, next) {
  verifyParentGrant(req, 'x-parent-token', 'manage', false, (error, valid) => {
    if (error) return res.status(500).json({ detail: '家长授权验证失败' });
    if (!valid) return res.status(403).json({ detail: '请先验证家长密码' });
    next();
  });
}

const rateLimitBuckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const bucketKey = key(req);
    const now = Date.now();
    if (rateLimitBuckets.size > 5000) {
      for (const [storedKey, storedBucket] of rateLimitBuckets) {
        if (storedBucket.resetAt <= now) rateLimitBuckets.delete(storedKey);
      }
    }
    const bucket = rateLimitBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      rateLimitBuckets.set(bucketKey, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ detail: '操作过于频繁，请稍后再试' });
    }
    next();
  };
}

const loginRateLimit = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  key: req => `login:${req.ip}`
});
const pinRateLimit = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 12,
  key: req => `pin:${req.userId}:${req.ip}`
});

function audit(userId, action, entityType = null, entityId = null, metadata = null) {
  db.run(
    `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, metadata)
     VALUES (?, ?, ?, ?, ?)`,
    [userId || null, action, entityType, entityId ? String(entityId) : null,
      metadata ? JSON.stringify(metadata) : null]
  );
}

function auth(req, res, next) {
  const authorization = req.headers.authorization || '';
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return res.status(401).json({ detail: '未登录' });

  const tokenHash = crypto.createHash('sha256').update(match[1]).digest('hex');
  db.get(
    'SELECT user_id, expires_at FROM auth_tokens WHERE token_hash = ?',
    [tokenHash],
    (error, tokenData) => {
      if (error) return res.status(500).json({ detail: '认证服务异常' });
      if (!tokenData || tokenData.expires_at <= Date.now()) {
        if (tokenData) db.run('DELETE FROM auth_tokens WHERE token_hash = ?', [tokenHash]);
        return res.status(401).json({ detail: '登录已过期' });
      }
      req.userId = tokenData.user_id;
      req.tokenHash = tokenHash;
      next();
    }
  );
}

function validUsername(username) {
  return typeof username === 'string' && /^[A-Za-z0-9_.-]{3,32}$/.test(username);
}

function validNickname(nickname) {
  return typeof nickname === 'string' && nickname.trim().length >= 1 && nickname.trim().length <= 30;
}

function validAvatar(avatar) {
  return typeof avatar === 'string' && avatar.trim().length >= 1 && avatar.trim().length <= 8;
}

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validBedtime(bedtime) {
  return typeof bedtime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(bedtime);
}

function validPin(pin) {
  return typeof pin === 'string' && /^\d{4}$/.test(pin);
}

function shortText(value, maxLength = 100) {
  return value === null || value === undefined ||
    (typeof value === 'string' && value.length <= maxLength);
}

function parsePositiveId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function resolveOwnedChild(userId, rawChildId, callback) {
  if (rawChildId !== undefined && rawChildId !== null && rawChildId !== '') {
    const childId = parsePositiveId(rawChildId);
    if (!childId) return callback({ status: 400, detail: '孩子档案编号不正确' });
    return db.get(
      'SELECT * FROM child_profiles WHERE id = ? AND user_id = ? AND archived_at IS NULL',
      [childId, userId],
      (error, child) => {
        if (error) return callback({ status: 500, detail: '孩子档案读取失败' });
        if (!child) return callback({ status: 404, detail: '孩子档案不存在' });
        callback(null, child);
      }
    );
  }

  db.get(
    `SELECT * FROM child_profiles
     WHERE user_id = ? AND archived_at IS NULL
     ORDER BY is_default DESC, id ASC LIMIT 1`,
    [userId],
    (error, child) => {
      if (error) return callback({ status: 500, detail: '孩子档案读取失败' });
      if (child) return callback(null, child);

      db.get('SELECT nickname, bedtime FROM users WHERE id = ?', [userId], (userError, user) => {
        if (userError) return callback({ status: 500, detail: '孩子档案读取失败' });
        if (!user) return callback({ status: 404, detail: '用户不存在' });
        db.run(
          `INSERT INTO child_profiles (
            user_id, name, avatar, bedtime, weekend_bedtime, is_default
           ) VALUES (?, ?, '🌙', ?, ?, 1)`,
          [userId, user.nickname, user.bedtime || '21:30', user.bedtime || '21:30'],
          function onInsert(insertError) {
            if (insertError) return callback({ status: 500, detail: '孩子档案创建失败' });
            db.get('SELECT * FROM child_profiles WHERE id = ?', [this.lastID], (readError, created) => {
              if (readError) return callback({ status: 500, detail: '孩子档案读取失败' });
              callback(null, created);
            });
          }
        );
      });
    }
  );
}

function childErrorResponse(res, error) {
  return res.status(error.status || 500).json({ detail: error.detail || '孩子档案读取失败' });
}

app.post('/api/auth/register', (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const nickname = typeof req.body.nickname === 'string' ? req.body.nickname.trim() : '';
  const password = req.body.password;

  if (!validUsername(username)) {
    return res.status(400).json({ detail: '用户名需为3-32位字母、数字、点、短横线或下划线' });
  }
  if (!validNickname(nickname)) {
    return res.status(400).json({ detail: '昵称需为1-30个字符' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ detail: '密码需为8-128位' });
  }

  db.get('SELECT id FROM users WHERE username = ?', [username], (error, existing) => {
    if (error) return res.status(500).json({ detail: '注册失败' });
    if (existing) return res.status(400).json({ detail: '用户名已存在' });

    db.run(
      'INSERT INTO users (username, nickname, password_hash, pin_code) VALUES (?, ?, ?, NULL)',
      [username, nickname, hashPassword(password)],
      function onInsert(insertError) {
        if (insertError) {
          if (insertError.code === 'SQLITE_CONSTRAINT') {
            return res.status(400).json({ detail: '用户名已存在' });
          }
          return res.status(500).json({ detail: '注册失败' });
        }

        const userId = this.lastID;
        db.run(
          `INSERT INTO child_profiles (
            user_id, name, avatar, bedtime, weekend_bedtime, is_default
           ) VALUES (?, ?, '🌙', '21:30', '21:30', 1)`,
          [userId, nickname],
          function onChildInsert(childError) {
            if (childError) {
              db.run('DELETE FROM users WHERE id = ?', [userId]);
              return res.status(500).json({ detail: '孩子档案创建失败' });
            }
            const childId = this.lastID;
            createToken(userId, (tokenError, token) => {
              if (tokenError) return res.status(500).json({ detail: '登录状态创建失败' });
              res.status(201).json({ access_token: token, user_id: userId, child_id: childId, nickname });
            });
          }
        );
      }
    );
  });
});

app.post('/api/auth/login', loginRateLimit, (req, res) => {
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = req.body.password;
  if (!username || typeof password !== 'string') {
    return res.status(400).json({ detail: '请输入用户名和密码' });
  }

  db.get('SELECT * FROM users WHERE username = ?', [username], (error, user) => {
    if (error) return res.status(500).json({ detail: '登录失败' });
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ detail: '用户名或密码错误' });
    }

    if (!user.password_hash.startsWith('scrypt$')) {
      db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), user.id]);
    }

    createToken(user.id, (tokenError, token) => {
      if (tokenError) return res.status(500).json({ detail: '登录状态创建失败' });
      audit(user.id, 'auth.login');
      res.json({ access_token: token, user_id: user.id, nickname: user.nickname });
    });
  });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.run('DELETE FROM parent_grants WHERE user_id = ?', [req.userId], (grantError) => {
    if (grantError) return res.status(500).json({ detail: '退出失败' });
    db.run('DELETE FROM auth_tokens WHERE token_hash = ?', [req.tokenHash], (error) => {
      if (error) return res.status(500).json({ detail: '退出失败' });
      res.json({ message: '已退出' });
    });
  });
});

app.get('/api/auth/me', auth, (req, res) => {
  db.get('SELECT id, username, nickname FROM users WHERE id = ?', [req.userId], (error, user) => {
    if (error) return res.status(500).json({ detail: '用户信息读取失败' });
    if (!user) return res.status(404).json({ detail: '用户不存在' });
    res.json({ user_id: user.id, username: user.username, nickname: user.nickname });
  });
});

// ==================== Child Profiles ====================

app.get('/api/children', auth, (req, res) => {
  db.all(
    `SELECT * FROM child_profiles WHERE user_id = ?
     ORDER BY archived_at IS NOT NULL, is_default DESC, id ASC`,
    [req.userId],
    (error, children) => {
      if (error) return res.status(500).json({ detail: '孩子档案读取失败' });
      res.json(children || []);
    }
  );
});

app.post('/api/children', auth, parentAuth, (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const avatar = typeof req.body.avatar === 'string' ? req.body.avatar.trim() : '🌟';
  const bedtime = req.body.bedtime || '21:30';
  const weekendBedtime = req.body.weekend_bedtime || bedtime;
  if (!validNickname(name)) return res.status(400).json({ detail: '孩子昵称需为1-30个字符' });
  if (!validAvatar(avatar)) return res.status(400).json({ detail: '头像格式不正确' });
  if (!validBedtime(bedtime)) return res.status(400).json({ detail: '睡觉时间格式不正确' });
  if (!validBedtime(weekendBedtime)) return res.status(400).json({ detail: '周末睡觉时间格式不正确' });

  db.get(
    'SELECT COUNT(*) AS count FROM child_profiles WHERE user_id = ? AND archived_at IS NULL',
    [req.userId],
    (countError, row) => {
    if (countError) return res.status(500).json({ detail: '孩子档案创建失败' });
    if (row.count >= 6) return res.status(400).json({ detail: '每个家庭最多创建6个孩子档案' });

    db.run(
      `INSERT INTO child_profiles (
        user_id, name, avatar, bedtime, weekend_bedtime, is_default
       ) VALUES (?, ?, ?, ?, ?, 0)`,
      [req.userId, name, avatar, bedtime, weekendBedtime],
      function onInsert(error) {
        if (error) return res.status(500).json({ detail: '孩子档案创建失败' });
        db.get(
          `SELECT * FROM child_profiles WHERE id = ? AND user_id = ?`,
          [this.lastID, req.userId],
          (readError, child) => {
            if (readError) return res.status(500).json({ detail: '孩子档案读取失败' });
            res.status(201).json(child);
          }
        );
      }
    );
  });
});

app.put('/api/children/:id', auth, parentAuth, (req, res) => {
  const childId = parsePositiveId(req.params.id);
  if (!childId) return res.status(400).json({ detail: '孩子档案编号不正确' });
  const allowed = new Set([
    'name', 'avatar', 'bedtime', 'weekend_bedtime', 'reminder_enabled',
    'reminder_time', 'weekend_reminder_time', 'pause_reminder_minutes', 'weekly_goal', 'reward_text'
  ]);
  const keys = Object.keys(req.body || {});
  if (keys.length === 0 || keys.some(key => !allowed.has(key))) {
    return res.status(400).json({ detail: '孩子档案字段不正确' });
  }

  const values = [];
  const assignments = [];
  if (req.body.name !== undefined) {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!validNickname(name)) return res.status(400).json({ detail: '孩子昵称需为1-30个字符' });
    assignments.push('name = ?');
    values.push(name);
  }
  if (req.body.avatar !== undefined) {
    const avatar = typeof req.body.avatar === 'string' ? req.body.avatar.trim() : '';
    if (!validAvatar(avatar)) return res.status(400).json({ detail: '头像格式不正确' });
    assignments.push('avatar = ?');
    values.push(avatar);
  }
  if (req.body.bedtime !== undefined) {
    if (!validBedtime(req.body.bedtime)) return res.status(400).json({ detail: '睡觉时间格式不正确' });
    assignments.push('bedtime = ?');
    values.push(req.body.bedtime);
  }
  if (req.body.weekend_bedtime !== undefined) {
    if (!validBedtime(req.body.weekend_bedtime)) {
      return res.status(400).json({ detail: '周末睡觉时间格式不正确' });
    }
    assignments.push('weekend_bedtime = ?');
    values.push(req.body.weekend_bedtime);
  }
  if (req.body.reminder_enabled !== undefined) {
    if (typeof req.body.reminder_enabled !== 'boolean') {
      return res.status(400).json({ detail: '提醒开关必须是布尔值' });
    }
    assignments.push('reminder_enabled = ?');
    values.push(req.body.reminder_enabled ? 1 : 0);
  }
  if (req.body.reminder_time !== undefined) {
    if (!validBedtime(req.body.reminder_time)) return res.status(400).json({ detail: '提醒时间格式不正确' });
    assignments.push('reminder_time = ?');
    values.push(req.body.reminder_time);
  }
  if (req.body.weekend_reminder_time !== undefined) {
    if (!validBedtime(req.body.weekend_reminder_time)) {
      return res.status(400).json({ detail: '周末提醒时间格式不正确' });
    }
    assignments.push('weekend_reminder_time = ?');
    values.push(req.body.weekend_reminder_time);
  }
  if (req.body.pause_reminder_minutes !== undefined) {
    const minutes = Number(req.body.pause_reminder_minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) {
      return res.status(400).json({ detail: '暂停提醒需为5-120分钟' });
    }
    assignments.push('pause_reminder_minutes = ?');
    values.push(minutes);
  }
  if (req.body.weekly_goal !== undefined) {
    const goal = Number(req.body.weekly_goal);
    if (!Number.isInteger(goal) || goal < 1 || goal > 7) {
      return res.status(400).json({ detail: '周目标需为1-7天' });
    }
    assignments.push('weekly_goal = ?');
    values.push(goal);
  }
  if (req.body.reward_text !== undefined) {
    const rewardText = typeof req.body.reward_text === 'string' ? req.body.reward_text.trim() : '';
    if (!rewardText || rewardText.length > 80) return res.status(400).json({ detail: '奖励内容需为1-80个字符' });
    assignments.push('reward_text = ?');
    values.push(rewardText);
  }

  assignments.push('updated_at = CURRENT_TIMESTAMP');
  values.push(childId, req.userId);
  db.run(
    `UPDATE child_profiles SET ${assignments.join(', ')}
     WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
    values,
    function onUpdate(error) {
      if (error) return res.status(500).json({ detail: '孩子档案保存失败' });
      if (this.changes === 0) return res.status(404).json({ detail: '孩子档案不存在' });
      db.get(
        `SELECT * FROM child_profiles WHERE id = ? AND user_id = ?`,
        [childId, req.userId],
        (readError, child) => {
          if (readError) return res.status(500).json({ detail: '孩子档案读取失败' });
          res.json(child);
        }
      );
    }
  );
});

app.post('/api/children/:id/archive', auth, parentAuth, (req, res) => {
  const childId = parsePositiveId(req.params.id);
  const archived = req.body.archived;
  if (!childId) return res.status(400).json({ detail: '孩子档案编号不正确' });
  if (typeof archived !== 'boolean') return res.status(400).json({ detail: '归档状态必须是布尔值' });

  db.get(
    'SELECT * FROM child_profiles WHERE id = ? AND user_id = ?',
    [childId, req.userId],
    (readError, child) => {
      if (readError) return res.status(500).json({ detail: '孩子档案读取失败' });
      if (!child) return res.status(404).json({ detail: '孩子档案不存在' });
      if (archived && child.is_default) {
        return res.status(400).json({ detail: '首个孩子档案不能归档' });
      }
      if (archived === Boolean(child.archived_at)) return res.json(child);

      const updateArchiveState = () => {
        db.run(
          `UPDATE child_profiles
           SET archived_at = ${archived ? 'CURRENT_TIMESTAMP' : 'NULL'}, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND user_id = ?`,
          [childId, req.userId],
          function onUpdate(updateError) {
            if (updateError) return res.status(500).json({ detail: archived ? '档案归档失败' : '档案恢复失败' });
            if (this.changes === 0) return res.status(404).json({ detail: '孩子档案不存在' });
            db.get(
              `SELECT * FROM child_profiles WHERE id = ? AND user_id = ?`,
              [childId, req.userId],
              (updatedError, updated) => {
                if (updatedError) return res.status(500).json({ detail: '孩子档案读取失败' });
                res.json(updated);
              }
            );
          }
        );
      };

      if (archived) return updateArchiveState();
      db.get(
        `SELECT COUNT(*) AS count FROM child_profiles
         WHERE user_id = ? AND archived_at IS NULL`,
        [req.userId],
        (countError, row) => {
          if (countError) return res.status(500).json({ detail: '档案恢复失败' });
          if (row.count >= 6) return res.status(400).json({ detail: '当前已有6个孩子档案，无法恢复' });
          updateArchiveState();
        }
      );
    }
  );
});

// ==================== Parent Settings ====================

app.get('/api/settings', auth, (req, res) => {
  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.get(
      'SELECT bedtime, settings_initialized, parent_pin_hash, pin_code FROM users WHERE id = ?',
      [req.userId],
      (error, user) => {
        if (error) return res.status(500).json({ detail: '设置读取失败' });
        if (!user) return res.status(404).json({ detail: '用户不存在' });
        res.json({
          child_id: child.id,
          bedtime: child.bedtime,
          weekend_bedtime: child.weekend_bedtime || child.bedtime,
          initialized: Boolean(user.settings_initialized || user.bedtime),
          pin_configured: Boolean(
            user.parent_pin_hash || (user.pin_code && user.pin_code !== '1234')
          )
        });
      }
    );
  });
});

app.put('/api/settings', auth, parentAuth, (req, res) => {
  const userUpdates = [];
  const userValues = [];
  const childUpdates = [];
  const childValues = [];

  if (req.body.bedtime !== undefined) {
    if (!validBedtime(req.body.bedtime)) {
      return res.status(400).json({ detail: '睡觉时间格式不正确' });
    }
    userUpdates.push('bedtime = ?');
    userValues.push(req.body.bedtime);
    childUpdates.push('bedtime = ?');
    childValues.push(req.body.bedtime);
  }

  if (req.body.weekend_bedtime !== undefined) {
    if (!validBedtime(req.body.weekend_bedtime)) {
      return res.status(400).json({ detail: '周末睡觉时间格式不正确' });
    }
    childUpdates.push('weekend_bedtime = ?');
    childValues.push(req.body.weekend_bedtime);
  }

  if (req.body.parent_pin !== undefined) {
    if (!validPin(req.body.parent_pin)) {
      return res.status(400).json({ detail: '家长密码必须是4位数字' });
    }
    userUpdates.push('parent_pin_hash = ?', 'pin_code = NULL');
    userValues.push(hashPassword(req.body.parent_pin));
  }

  if (childUpdates.length > 0) userUpdates.push('settings_initialized = 1');
  if (userUpdates.length === 0) return res.status(400).json({ detail: '没有可保存的设置' });

  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    userValues.push(req.userId);
    db.run(`UPDATE users SET ${userUpdates.join(', ')} WHERE id = ?`, userValues, function onUpdate(error) {
      if (error) return res.status(500).json({ detail: '设置保存失败' });
      if (this.changes === 0) return res.status(404).json({ detail: '用户不存在' });

      const respondWithSavedSettings = () => db.get(
        'SELECT id, bedtime, weekend_bedtime FROM child_profiles WHERE id = ? AND user_id = ?',
        [child.id, req.userId],
        (readError, savedChild) => {
          if (readError) return res.status(500).json({ detail: '孩子睡觉时间读取失败' });
          res.json({
            child_id: savedChild.id,
            bedtime: savedChild.bedtime,
            weekend_bedtime: savedChild.weekend_bedtime || savedChild.bedtime,
            saved: true
          });
        }
      );

      if (childUpdates.length === 0) return respondWithSavedSettings();
      childUpdates.push('updated_at = CURRENT_TIMESTAMP');
      childValues.push(child.id, req.userId);
      db.run(
        `UPDATE child_profiles SET ${childUpdates.join(', ')}
         WHERE id = ? AND user_id = ? AND archived_at IS NULL`,
        childValues,
        (childUpdateError) => {
          if (childUpdateError) return res.status(500).json({ detail: '孩子睡觉时间保存失败' });
          respondWithSavedSettings();
        }
      );
    });
  });
});

app.post('/api/settings/verify-pin', auth, pinRateLimit, (req, res) => {
  const pin = req.body.parent_pin;
  const purpose = req.body.purpose || 'manage';
  if (!validPin(pin)) return res.status(400).json({ detail: '家长密码必须是4位数字' });
  if (!['manage', 'approve'].includes(purpose)) {
    return res.status(400).json({ detail: '家长验证用途不正确' });
  }

  db.get(
    'SELECT parent_pin_hash, pin_code FROM users WHERE id = ?',
    [req.userId],
    (error, user) => {
      if (error) return res.status(500).json({ detail: '家长密码验证失败' });
      if (!user) return res.status(404).json({ detail: '用户不存在' });

      const valid = user.parent_pin_hash
        ? verifyPassword(pin, user.parent_pin_hash)
        : pin === (user.pin_code || '1234');

      if (!valid) {
        audit(req.userId, 'parent.pin_failed', 'user', req.userId, { purpose });
        return res.json({ valid: false });
      }

      if (!user.parent_pin_hash) {
        db.run(
          'UPDATE users SET parent_pin_hash = ?, pin_code = NULL WHERE id = ?',
          [hashPassword(pin), req.userId]
        );
      }

      createParentGrant(req.userId, purpose, (grantError, grant) => {
        if (grantError) return res.status(500).json({ detail: '家长授权创建失败' });
        audit(req.userId, 'parent.grant_created', 'user', req.userId, { purpose });
        const tokenField = purpose === 'manage' ? 'parent_token' : 'approval_token';
        res.json({ valid: true, [tokenField]: grant.token, expires_at: grant.expiresAt });
      });
    }
  );
});

app.delete('/api/settings/parent-access', auth, parentAuth, (req, res) => {
  db.run(
    'DELETE FROM parent_grants WHERE token_hash = ? AND user_id = ?',
    [req.parentTokenHash, req.userId],
    (error) => {
      if (error) return res.status(500).json({ detail: '家长模式锁定失败' });
      res.json({ message: '已退出家长模式' });
    }
  );
});

// ==================== Family Launcher & Preferences ====================

app.get('/api/family/preferences', auth, (req, res) => {
  db.run(
    `INSERT INTO family_preferences (user_id) VALUES (?)
     ON CONFLICT(user_id) DO NOTHING`,
    [req.userId],
    (insertError) => {
      if (insertError) return res.status(500).json({ detail: '家庭偏好读取失败' });
      db.get(
        'SELECT allow_child_switch FROM family_preferences WHERE user_id = ?',
        [req.userId],
        (error, row) => {
          if (error) return res.status(500).json({ detail: '家庭偏好读取失败' });
          res.json({ allow_child_switch: Boolean(row?.allow_child_switch) });
        }
      );
    }
  );
});

app.put('/api/family/preferences', auth, parentAuth, (req, res) => {
  if (typeof req.body.allow_child_switch !== 'boolean') {
    return res.status(400).json({ detail: '孩子切换权限必须是布尔值' });
  }
  db.run(
    `INSERT INTO family_preferences (user_id, allow_child_switch)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       allow_child_switch = excluded.allow_child_switch,
       updated_at = CURRENT_TIMESTAMP`,
    [req.userId, req.body.allow_child_switch ? 1 : 0],
    (error) => {
      if (error) return res.status(500).json({ detail: '家庭偏好保存失败' });
      audit(req.userId, 'family.preferences_updated', 'user', req.userId, req.body);
      res.json({ saved: true, allow_child_switch: req.body.allow_child_switch });
    }
  );
});

// ==================== Reminders ====================

const REMINDER_TYPES = new Set(['daily_start', 'pause_too_long', 'bedtime_near', 'test']);
const REMINDER_STATUSES = new Set(['delivered', 'blocked', 'unsupported', 'failed']);

app.post('/api/reminders/events', auth, (req, res) => {
  if (!REMINDER_TYPES.has(req.body.event_type) || !REMINDER_STATUSES.has(req.body.status)) {
    return res.status(400).json({ detail: '提醒事件格式不正确' });
  }
  if (!shortText(req.body.detail, 200)) return res.status(400).json({ detail: '提醒说明过长' });
  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.run(
      `INSERT INTO reminder_events (user_id, child_id, event_type, status, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [req.userId, child.id, req.body.event_type, req.body.status, req.body.detail || null],
      function onInsert(error) {
        if (error) return res.status(500).json({ detail: '提醒状态记录失败' });
        res.status(201).json({ id: this.lastID, recorded: true });
      }
    );
  });
});

app.get('/api/reminders/events', auth, parentAuth, (req, res) => {
  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.all(
      `SELECT id, event_type, status, detail, created_at FROM reminder_events
       WHERE user_id = ? AND child_id = ? ORDER BY id DESC LIMIT 20`,
      [req.userId, child.id],
      (error, rows) => {
        if (error) return res.status(500).json({ detail: '提醒状态读取失败' });
        res.json(rows || []);
      }
    );
  });
});

function beijingDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function addDateDays(dateString, days) {
  const date = new Date(`${dateString}T12:00:00+08:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return beijingDateString(date);
}

function currentWeekStart() {
  const today = beijingDateString();
  const date = new Date(`${today}T12:00:00+08:00`);
  return addDateDays(today, -date.getUTCDay());
}

function calculateStreak(sessions, protections = []) {
  const completedDates = new Set(sessions.filter(row => row.completed).map(row => row.date));
  const protectedDates = new Set(protections.map(row => row.protected_date));
  let cursor = beijingDateString();
  if (!completedDates.has(cursor)) cursor = addDateDays(cursor, -1);
  let streak = 0;
  while ((completedDates.has(cursor) || protectedDates.has(cursor)) && streak < 365) {
    if (completedDates.has(cursor)) streak += 1;
    cursor = addDateDays(cursor, -1);
  }
  return streak;
}

// ==================== Growth & Weekly Report ====================

app.get('/api/insights/weekly', auth, parentAuth, (req, res) => {
  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    const weekStart = currentWeekStart();
    const previousWeekStart = addDateDays(weekStart, -7);
    db.all(
      `SELECT * FROM homework_sessions
       WHERE user_id = ? AND child_id = ? AND date >= ? ORDER BY date ASC`,
      [req.userId, child.id, addDateDays(weekStart, -28)],
      (error, sessions = []) => {
        if (error) return res.status(500).json({ detail: '周报读取失败' });
        const current = sessions.filter(row => row.date >= weekStart);
        const previous = sessions.filter(row => row.date >= previousWeekStart && row.date < weekStart);
        const complete = rows => rows.filter(row => row.completed);
        const average = (rows, field) => rows.length
          ? rows.reduce((sum, row) => sum + Number(row[field] || 0), 0) / rows.length
          : 0;
        db.all(
          `SELECT protected_date, reason FROM streak_protections
           WHERE user_id = ? AND child_id = ? AND protected_date >= ?`,
          [req.userId, child.id, addDateDays(weekStart, -28)],
          (protectionError, protections = []) => {
            if (protectionError) return res.status(500).json({ detail: '中断保护读取失败' });
            db.get(
              `SELECT * FROM weekly_rewards
               WHERE user_id = ? AND child_id = ? AND week_start = ?`,
              [req.userId, child.id, weekStart],
              (rewardError, reward) => {
            if (rewardError) return res.status(500).json({ detail: '周奖励读取失败' });
            const completed = complete(current);
            res.json({
              child_id: child.id,
              week_start: weekStart,
              goal: child.weekly_goal || 5,
              reward_text: reward?.reward_text || child.reward_text,
              reward_status: reward?.status || 'pending',
              completed_days: completed.length,
              goal_reached: completed.length >= (child.weekly_goal || 5),
              streak_days: calculateStreak(sessions, protections),
              protected_date: protections.find(item => item.protected_date >= weekStart)?.protected_date || null,
              protection_available: !protections.some(item => item.protected_date >= weekStart),
              avg_homework_minutes: average(completed, 'homework_minutes'),
              avg_playtime_minutes: average(completed, 'playtime_minutes'),
              previous_completed_days: complete(previous).length,
              days: current.map(row => ({
                date: row.date,
                completed: Boolean(row.completed),
                protected: protections.some(item => item.protected_date === row.date),
                homework_minutes: row.homework_minutes || 0,
                playtime_minutes: row.playtime_minutes || 0
              })).concat(protections.filter(item => item.protected_date >= weekStart &&
                !current.some(row => row.date === item.protected_date)).map(item => ({
                date: item.protected_date, completed: false, protected: true,
                homework_minutes: 0, playtime_minutes: 0
              })))
            });
              }
            );
          }
        );
      }
    );
  });
});

app.post('/api/growth/protection', auth, parentAuth, (req, res) => {
  const protectedDate = req.body.date;
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const weekStart = currentWeekStart();
  const weekEnd = addDateDays(weekStart, 6);
  if (!validDate(protectedDate) || protectedDate < weekStart || protectedDate > weekEnd ||
      protectedDate > beijingDateString()) {
    return res.status(400).json({ detail: '只能保护本周的一天' });
  }
  if (!reason || reason.length > 80) return res.status(400).json({ detail: '保护原因需为1-80个字符' });
  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.get(
      `SELECT completed FROM homework_sessions
       WHERE user_id = ? AND child_id = ? AND date = ?`,
      [req.userId, child.id, protectedDate],
      (sessionError, session) => {
        if (sessionError) return res.status(500).json({ detail: '中断保护检查失败' });
        if (session?.completed) return res.status(400).json({ detail: '已完成日期不需要中断保护' });
        db.run(
          `INSERT INTO streak_protections (
            user_id, child_id, protected_date, week_start, reason
          ) VALUES (?, ?, ?, ?, ?)`,
          [req.userId, child.id, protectedDate, weekStart, reason],
          function onInsert(error) {
            if (error?.code === 'SQLITE_CONSTRAINT') {
              return res.status(400).json({ detail: '本周已经使用过一次中断保护' });
            }
            if (error) return res.status(500).json({ detail: '中断保护保存失败' });
            audit(req.userId, 'growth.protection_added', 'child', child.id, { protectedDate, reason });
            res.status(201).json({ id: this.lastID, protected_date: protectedDate, week_start: weekStart });
          }
        );
      }
    );
  });
});

app.put('/api/rewards/current', auth, parentAuth, (req, res) => {
  const status = req.body.status || 'pending';
  const rewardText = typeof req.body.reward_text === 'string' ? req.body.reward_text.trim() : '';
  if (!['pending', 'approved', 'redeemed'].includes(status)) {
    return res.status(400).json({ detail: '奖励状态不正确' });
  }
  if (!rewardText || rewardText.length > 80) return res.status(400).json({ detail: '奖励内容需为1-80个字符' });
  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    const weekStart = currentWeekStart();
    db.run(
      `INSERT INTO weekly_rewards (user_id, child_id, week_start, reward_text, status)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, child_id, week_start) DO UPDATE SET
         reward_text = excluded.reward_text, status = excluded.status,
         updated_at = CURRENT_TIMESTAMP`,
      [req.userId, child.id, weekStart, rewardText, status],
      (error) => {
        if (error) return res.status(500).json({ detail: '周奖励保存失败' });
        audit(req.userId, 'reward.updated', 'child', child.id, { weekStart, status });
        res.json({ saved: true, child_id: child.id, week_start: weekStart, reward_text: rewardText, status });
      }
    );
  });
});

// ==================== Plan Validation ====================

app.get('/api/plan', auth, (req, res) => {
  db.get('SELECT plan_tier, trial_started_at FROM users WHERE id = ?', [req.userId], (error, user) => {
    if (error) return res.status(500).json({ detail: '套餐状态读取失败' });
    const trialEndsAt = user?.trial_started_at
      ? new Date(new Date(user.trial_started_at).getTime() + 14 * 86400000).toISOString()
      : null;
    res.json({
      plan_tier: user?.plan_tier || 'free',
      trial_started_at: user?.trial_started_at || null,
      trial_ends_at: trialEndsAt,
      family_features: ['多孩子档案', '提醒触达记录', '成长周报', '跨设备冲突处理', '数据备份']
    });
  });
});

app.post('/api/plan/trial', auth, parentAuth, (req, res) => {
  db.run(
    `UPDATE users SET plan_tier = 'family_trial',
       trial_started_at = COALESCE(trial_started_at, CURRENT_TIMESTAMP)
     WHERE id = ? AND plan_tier = 'free'`,
    [req.userId],
    function onUpdate(error) {
      if (error) return res.status(500).json({ detail: '试用开启失败' });
      audit(req.userId, 'plan.trial_started', 'user', req.userId);
      res.json({ started: this.changes > 0, plan_tier: this.changes > 0 ? 'family_trial' : undefined });
    }
  );
});

app.post('/api/product-events', auth, parentAuth, (req, res) => {
  const eventType = req.body.event_type;
  const pricePoint = Number(req.body.price_point);
  if (!['pricing_viewed', 'purchase_intent', 'trial_feedback'].includes(eventType)) {
    return res.status(400).json({ detail: '产品事件不正确' });
  }
  if (req.body.price_point !== undefined && (!Number.isInteger(pricePoint) || pricePoint < 0 || pricePoint > 99900)) {
    return res.status(400).json({ detail: '价格点不正确' });
  }
  if (!shortText(req.body.feedback, 300)) return res.status(400).json({ detail: '反馈内容过长' });
  db.run(
    `INSERT INTO product_events (user_id, event_type, plan_code, price_point, metadata)
     VALUES (?, ?, 'family', ?, ?)`,
    [req.userId, eventType, req.body.price_point === undefined ? null : pricePoint,
      JSON.stringify({ feedback: req.body.feedback || '' })],
    function onInsert(error) {
      if (error) return res.status(500).json({ detail: '意向记录失败' });
      res.status(201).json({ id: this.lastID, recorded: true });
    }
  );
});

app.get('/api/product-metrics', auth, parentAuth, (req, res) => {
  db.get('SELECT created_at FROM users WHERE id = ?', [req.userId], (userError, user) => {
    if (userError) return res.status(500).json({ detail: '验证指标读取失败' });
    db.get(
      `SELECT COUNT(*) AS child_count FROM child_profiles
       WHERE user_id = ? AND archived_at IS NULL`,
      [req.userId],
      (childError, children) => {
        if (childError) return res.status(500).json({ detail: '验证指标读取失败' });
        db.get(
          `SELECT COUNT(*) AS total_sessions, COUNT(DISTINCT date) AS active_days,
             MIN(date) AS first_session_date, MAX(date) AS latest_session_date,
             SUM(CASE WHEN date >= ? THEN 1 ELSE 0 END) AS sessions_last_7_days
           FROM homework_sessions WHERE user_id = ?`,
          [addDateDays(beijingDateString(), -6), req.userId],
          (sessionError, sessions) => {
            if (sessionError) return res.status(500).json({ detail: '验证指标读取失败' });
            db.all(
              `SELECT event_type, COUNT(*) AS count, MAX(created_at) AS latest
               FROM product_events WHERE user_id = ? GROUP BY event_type`,
              [req.userId],
              (eventError, rows) => {
                if (eventError) return res.status(500).json({ detail: '验证指标读取失败' });
                const activitySpan = sessions.first_session_date && sessions.latest_session_date
                  ? Math.round((new Date(`${sessions.latest_session_date}T12:00:00+08:00`) -
                    new Date(`${sessions.first_session_date}T12:00:00+08:00`)) / 86400000)
                  : 0;
                res.json({
                  events: rows || [],
                  funnel: {
                    activated: sessions.total_sessions > 0,
                    active_days: sessions.active_days || 0,
                    retained_7d: sessions.active_days >= 2 && activitySpan >= 6,
                    sessions_last_7_days: sessions.sessions_last_7_days || 0,
                    child_count: children.child_count || 0,
                    account_created_at: user?.created_at || null,
                    purchase_intent: (rows || []).some(row => row.event_type === 'purchase_intent')
                  }
                });
              }
            );
          }
        );
      }
    );
  });
});

app.post('/api/sessions', auth, (req, res) => {
  const { date, bedtime = '21:30' } = req.body;
  if (!validDate(date) || !validBedtime(bedtime)) {
    return res.status(400).json({ detail: '日期或睡觉时间格式不正确' });
  }

  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.run(
      `INSERT INTO homework_sessions (user_id, child_id, date, bedtime, state)
       VALUES (?, ?, ?, ?, 'idle')
       ON CONFLICT(user_id, child_id, date) DO UPDATE SET
         bedtime = excluded.bedtime, updated_at = CURRENT_TIMESTAMP`,
      [req.userId, child.id, date, bedtime],
      (error) => {
        if (error) return res.status(500).json({ detail: '创建失败' });
        db.get(
          'SELECT * FROM homework_sessions WHERE user_id = ? AND child_id = ? AND date = ?',
          [req.userId, child.id, date],
          (readError, session) => {
            if (readError) return res.status(500).json({ detail: '记录读取失败' });
            res.status(201).json(session);
          }
        );
      }
    );
  });
});

app.get('/api/sessions', auth, (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.all(
      `SELECT * FROM homework_sessions
       WHERE user_id = ? AND child_id = ? ORDER BY date DESC LIMIT ?`,
      [req.userId, child.id, limit],
      (error, sessions) => {
        if (error) return res.status(500).json({ detail: '记录读取失败' });
        res.json(sessions || []);
      }
    );
  });
});

function normalizeImportedRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (!validDate(record.date) || !validBedtime(record.bedtime || '21:30')) return null;

  const numberFields = ['homework_seconds', 'paused_seconds', 'remaining_seconds'];
  if (numberFields.some(key => !Number.isFinite(record[key]) || record[key] < 0)) return null;
  if (!shortText(record.start_time) || !shortText(record.end_time) ||
      !shortText(record.reward_choice, 50) || !shortText(record.title, 50)) return null;

  return {
    date: record.date,
    bedtime: record.bedtime || '21:30',
    homeworkSeconds: record.homework_seconds,
    pausedSeconds: record.paused_seconds,
    remainingSeconds: record.remaining_seconds,
    startTime: record.start_time || null,
    endTime: record.end_time || null,
    homeworkDone: Boolean(record.homework_done),
    correctionDone: Boolean(record.correction_done),
    attitudeGood: Boolean(record.attitude_good),
    rewardChoice: record.reward_choice || null,
    title: record.title || null,
    callItADay: Boolean(record.call_it_a_day)
  };
}

app.post('/api/sessions/import', auth, parentAuth, (req, res) => {
  const records = req.body.records;
  if (!Array.isArray(records) || records.length === 0 || records.length > 100) {
    return res.status(400).json({ detail: '导入记录数量必须为1-100条' });
  }

  const normalized = records.map(normalizeImportedRecord);
  if (normalized.some(record => !record)) {
    return res.status(400).json({ detail: '导入记录格式不正确' });
  }

  resolveOwnedChild(req.userId, req.body.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    let imported = 0;
    let skipped = 0;
    let index = 0;

    const finish = (error) => {
      if (error) {
        return db.run('ROLLBACK', () => res.status(500).json({ detail: '记录导入失败' }));
      }
      db.run('COMMIT', (commitError) => {
        if (commitError) return res.status(500).json({ detail: '记录导入失败' });
        res.json({ imported, skipped });
      });
    };

    const importNext = () => {
      if (index >= normalized.length) return finish();
      const record = normalized[index++];
      const homeworkMinutes = record.homeworkSeconds / 60;
      const playtimeMinutes = record.remainingSeconds / 60;

      db.run(
        `INSERT INTO homework_sessions (
          user_id, child_id, date, homework_minutes, start_time, end_time, completed,
          homework_done, correction_done, attitude_good, playtime_type,
          playtime_minutes, bedtime, state, homework_seconds, paused_seconds,
          remaining_seconds, reward_choice, title, call_it_a_day
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, child_id, date) DO UPDATE SET
          homework_minutes = excluded.homework_minutes,
          start_time = excluded.start_time,
          end_time = excluded.end_time,
          completed = 1,
          homework_done = excluded.homework_done,
          correction_done = excluded.correction_done,
          attitude_good = excluded.attitude_good,
          playtime_type = excluded.playtime_type,
          playtime_minutes = excluded.playtime_minutes,
          bedtime = excluded.bedtime,
          state = 'completed',
          homework_seconds = excluded.homework_seconds,
          paused_seconds = excluded.paused_seconds,
          remaining_seconds = excluded.remaining_seconds,
          reward_choice = excluded.reward_choice,
          title = excluded.title,
          call_it_a_day = excluded.call_it_a_day,
          updated_at = CURRENT_TIMESTAMP
        WHERE homework_sessions.completed = 0`,
        [
          req.userId, child.id, record.date, homeworkMinutes, record.startTime, record.endTime,
          record.homeworkDone, record.correctionDone, record.attitudeGood,
          record.rewardChoice, playtimeMinutes, record.bedtime, record.homeworkSeconds,
          record.pausedSeconds, record.remainingSeconds, record.rewardChoice,
          record.title, record.callItADay
        ],
        function onImport(error) {
          if (error) return finish(error);
          if (this.changes > 0) imported += 1;
          else skipped += 1;
          importNext();
        }
      );
    };

    db.run('BEGIN IMMEDIATE', (error) => {
      if (error) return res.status(500).json({ detail: '记录导入失败' });
      importNext();
    });
  });
});

const SESSION_UPDATE_FIELDS = new Set([
  'homework_minutes', 'total_minutes', 'start_time', 'end_time', 'completed',
  'homework_done', 'correction_done', 'attitude_good', 'playtime_type',
  'playtime_minutes', 'bedtime', 'state', 'homework_seconds', 'paused_seconds',
  'remaining_seconds', 'reward_choice', 'title', 'call_it_a_day'
]);
const NUMBER_FIELDS = new Set([
  'homework_minutes', 'total_minutes', 'playtime_minutes', 'homework_seconds',
  'paused_seconds', 'remaining_seconds'
]);
const BOOLEAN_FIELDS = new Set([
  'completed', 'homework_done', 'correction_done', 'attitude_good', 'call_it_a_day'
]);
const VALID_STATES = new Set(['idle', 'running', 'paused', 'reviewing', 'completed']);
const CHILD_COMPLETED_UPDATE_FIELDS = new Set(['playtime_type', 'reward_choice']);

function validateSessionUpdates(updates) {
  const keys = Object.keys(updates);
  if (keys.some((key) => !SESSION_UPDATE_FIELDS.has(key))) return '包含不允许更新的字段';

  for (const key of keys) {
    const value = updates[key];
    if (NUMBER_FIELDS.has(key) && (!Number.isFinite(value) || value < 0)) return `${key} 必须是非负数`;
    if (BOOLEAN_FIELDS.has(key) && typeof value !== 'boolean' && value !== 0 && value !== 1) {
      return `${key} 必须是布尔值`;
    }
    if (key === 'bedtime' && !validBedtime(value)) return '睡觉时间格式不正确';
    if (key === 'state' && !VALID_STATES.has(value)) return '状态值不正确';
    if (['start_time', 'end_time', 'playtime_type', 'reward_choice', 'title'].includes(key) &&
        value !== null && (typeof value !== 'string' || value.length > 100)) {
      return `${key} 格式不正确`;
    }
  }
  return null;
}

app.put('/api/sessions/:id', auth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: '记录编号不正确' });

  const requestBody = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const clientVersion = requestBody.client_version;
  const deviceId = typeof requestBody.device_id === 'string' ? requestBody.device_id.slice(0, 80) : null;
  const updates = Object.fromEntries(
    Object.entries(requestBody).filter(([key]) => !['client_version', 'device_id'].includes(key))
  );
  if (clientVersion !== undefined && (!Number.isInteger(clientVersion) || clientVersion < 1)) {
    return res.status(400).json({ detail: '记录版本号不正确' });
  }
  const validationError = validateSessionUpdates(updates);
  if (validationError) return res.status(400).json({ detail: validationError });

  db.get(
    'SELECT * FROM homework_sessions WHERE id = ? AND user_id = ?',
    [id, req.userId],
    (error, session) => {
      if (error) return res.status(500).json({ detail: '记录读取失败' });
      if (!session) return res.status(404).json({ detail: '记录不存在' });

      const keys = Object.keys(updates);
      if (keys.length === 0) return res.json(session);

      const saveConflict = (conflictSession = session) => db.run(
        `INSERT INTO sync_conflicts (
          user_id, child_id, session_id, device_id, base_version, server_version, client_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [req.userId, conflictSession.child_id, conflictSession.id, deviceId, clientVersion,
          conflictSession.version || 1,
          JSON.stringify(updates)],
        function onConflict(conflictError) {
          if (conflictError) return res.status(500).json({ detail: '同步冲突记录失败' });
          res.status(409).json({
            detail: '其他设备已更新这条记录，请由家长选择保留版本',
            conflict_id: this.lastID,
            server_session: conflictSession
          });
        }
      );
      if (clientVersion !== undefined && clientVersion !== (session.version || 1)) return saveConflict();

      const saveUpdates = () => {
        const assignments = keys.map((key) => `${key} = ?`);
        const values = keys.map((key) => updates[key]);
        assignments.push('version = version + 1', 'updated_at = CURRENT_TIMESTAMP');
        values.push(id, req.userId);
        if (clientVersion !== undefined) values.push(clientVersion);

        db.run(
          `UPDATE homework_sessions SET ${assignments.join(', ')}
           WHERE id = ? AND user_id = ?${clientVersion !== undefined ? ' AND version = ?' : ''}`,
          values,
          function onSessionUpdate(updateError) {
            if (updateError) return res.status(500).json({ detail: '更新失败' });
            if (this.changes === 0 && clientVersion !== undefined) {
              return db.get(
                'SELECT * FROM homework_sessions WHERE id = ? AND user_id = ?',
                [id, req.userId],
                (latestError, latest) => {
                  if (latestError || !latest) return res.status(500).json({ detail: '同步冲突读取失败' });
                  saveConflict(latest);
                }
              );
            }
            db.get('SELECT * FROM homework_sessions WHERE id = ?', [id], (readError, updated) => {
              if (readError) return res.status(500).json({ detail: '记录读取失败' });
              res.json(updated);
            });
          }
        );
      };

      if (session.completed) {
        if (keys.every(key => CHILD_COMPLETED_UPDATE_FIELDS.has(key))) return saveUpdates();
        return verifyParentGrant(req, 'x-parent-token', 'manage', false, (grantError, valid) => {
          if (grantError) return res.status(500).json({ detail: '家长授权验证失败' });
          if (!valid) return res.status(403).json({ detail: '已完成记录只能由家长修改' });
          saveUpdates();
        });
      }

      const requestsCompletion = updates.completed === true || updates.completed === 1 ||
        updates.state === 'completed';
      if (!requestsCompletion) return saveUpdates();
      verifyParentGrant(req, 'x-parent-approval', 'approve', true, (grantError, valid) => {
        if (grantError) return res.status(500).json({ detail: '家长确认验证失败' });
        if (!valid) return res.status(403).json({ detail: '完成作业需要家长确认' });
        saveUpdates();
      });
    }
  );
});

app.get('/api/sync/conflicts', auth, parentAuth, (req, res) => {
  db.all(
    `SELECT conflicts.*, sessions.date, children.name AS child_name
     FROM sync_conflicts conflicts
     JOIN homework_sessions sessions ON sessions.id = conflicts.session_id
     JOIN child_profiles children ON children.id = conflicts.child_id
     WHERE conflicts.user_id = ? AND conflicts.status = 'pending'
     ORDER BY conflicts.id DESC LIMIT 50`,
    [req.userId],
    (error, rows) => {
      if (error) return res.status(500).json({ detail: '同步冲突读取失败' });
      res.json((rows || []).map(row => ({
        ...row,
        client_payload: JSON.parse(row.client_payload)
      })));
    }
  );
});

app.post('/api/sync/conflicts/:id/resolve', auth, parentAuth, (req, res) => {
  const conflictId = parsePositiveId(req.params.id);
  const resolution = req.body.resolution;
  if (!conflictId || !['server', 'client'].includes(resolution)) {
    return res.status(400).json({ detail: '冲突处理选项不正确' });
  }
  db.get(
    `SELECT * FROM sync_conflicts
     WHERE id = ? AND user_id = ? AND status = 'pending'`,
    [conflictId, req.userId],
    (error, conflict) => {
      if (error) return res.status(500).json({ detail: '同步冲突读取失败' });
      if (!conflict) return res.status(404).json({ detail: '同步冲突不存在或已处理' });
      const finish = () => db.run(
        `UPDATE sync_conflicts SET status = ?, resolved_at = CURRENT_TIMESTAMP
         WHERE id = ? AND user_id = ? AND status = 'pending'`,
        [`resolved_${resolution}`, conflictId, req.userId],
        function onResolve(resolveError) {
          if (resolveError) return res.status(500).json({ detail: '同步冲突处理失败' });
          audit(req.userId, 'sync.conflict_resolved', 'sync_conflict', conflictId, { resolution });
          res.json({ resolved: this.changes === 1, resolution });
        }
      );
      if (resolution === 'server') return finish();

      let updates;
      try {
        updates = JSON.parse(conflict.client_payload);
      } catch {
        return res.status(500).json({ detail: '冲突数据损坏' });
      }
      const validationError = validateSessionUpdates(updates);
      if (validationError) return res.status(400).json({ detail: validationError });
      const keys = Object.keys(updates);
      if (keys.length === 0) return finish();
      const assignments = keys.map(key => `${key} = ?`);
      const values = keys.map(key => updates[key]);
      assignments.push('version = version + 1', 'updated_at = CURRENT_TIMESTAMP');
      values.push(conflict.session_id, req.userId);
      db.run(
        `UPDATE homework_sessions SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
        values,
        (updateError) => {
          if (updateError) return res.status(500).json({ detail: '客户端版本恢复失败' });
          finish();
        }
      );
    }
  );
});

app.delete('/api/sessions', auth, parentAuth, (req, res) => {
  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.run(
      'DELETE FROM homework_sessions WHERE user_id = ? AND child_id = ?',
      [req.userId, child.id],
      function onDelete(error) {
        if (error) return res.status(500).json({ detail: '记录清空失败' });
        res.json({ child_id: child.id, deleted: this.changes });
      }
    );
  });
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: '记录编号不正确' });

  db.get(
    'SELECT completed FROM homework_sessions WHERE id = ? AND user_id = ?',
    [id, req.userId],
    (readError, session) => {
      if (readError) return res.status(500).json({ detail: '记录读取失败' });
      if (!session) return res.status(404).json({ detail: '记录不存在' });

      const deleteSession = () => db.run(
        'DELETE FROM homework_sessions WHERE id = ? AND user_id = ?',
        [id, req.userId],
        function onDelete(error) {
          if (error) return res.status(500).json({ detail: '删除失败' });
          if (this.changes === 0) return res.status(404).json({ detail: '记录不存在' });
          res.json({ message: '已删除' });
        }
      );

      if (!session.completed) return deleteSession();
      verifyParentGrant(req, 'x-parent-token', 'manage', false, (grantError, valid) => {
        if (grantError) return res.status(500).json({ detail: '家长授权验证失败' });
        if (!valid) return res.status(403).json({ detail: '已完成记录只能由家长删除' });
        deleteSession();
      });
    }
  );
});

app.get('/api/stats', auth, parentAuth, (req, res) => {
  const requestedDays = Number.parseInt(req.query.days, 10);
  const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 365) : 30;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  resolveOwnedChild(req.userId, req.query.child_id, (childError, child) => {
    if (childError) return childErrorResponse(res, childError);
    db.all(
      `SELECT * FROM homework_sessions
       WHERE user_id = ? AND child_id = ? AND date >= ?`,
      [req.userId, child.id, cutoffDate],
      (error, sessions = []) => {
        if (error) return res.status(500).json({ detail: '统计读取失败' });
        const total = sessions.length;
        const totalHomework = sessions.reduce((sum, session) => sum + (session.homework_minutes || 0), 0);
        const totalPlaytime = sessions.reduce((sum, session) => sum + (session.playtime_minutes || 0), 0);
        const completed = sessions.filter((session) => session.completed).length;
        const stars = sessions.filter((session) =>
          session.completed && session.homework_done && session.correction_done && session.attitude_good
        ).length;

        res.json({
          child_id: child.id,
          total_sessions: total,
          total_homework_minutes: totalHomework,
          avg_homework_minutes: total > 0 ? totalHomework / total : 0,
          total_playtime_minutes: totalPlaytime,
          completion_rate: total > 0 ? completed / total : 0,
          star_days: stars
        });
      }
    );
  });
});

app.get('/api/audit-logs', auth, parentAuth, (req, res) => {
  db.all(
    `SELECT id, action, entity_type, entity_id, metadata, created_at
     FROM audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    [req.userId],
    (error, rows) => {
      if (error) return res.status(500).json({ detail: '审计日志读取失败' });
      res.json((rows || []).map(row => ({
        ...row,
        metadata: row.metadata ? JSON.parse(row.metadata) : null
      })));
    }
  );
});

app.get('/api/operations/status', auth, parentAuth, (req, res) => {
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const backups = fs.existsSync(backupDir)
    ? fs.readdirSync(backupDir).filter(name => name.endsWith('.db')).sort().reverse().slice(0, 5)
    : [];
  db.get('PRAGMA user_version', (versionError, version) => {
    if (versionError) return res.status(500).json({ detail: '运行状态读取失败' });
    db.get('PRAGMA integrity_check', (integrityError, integrity) => {
      if (integrityError) return res.status(500).json({ detail: '数据库完整性检查失败' });
      db.get(
        `SELECT COUNT(*) AS count FROM sync_conflicts
         WHERE user_id = ? AND status = 'pending'`,
        [req.userId],
        (conflictError, conflicts) => {
          if (conflictError) return res.status(500).json({ detail: '运行状态读取失败' });
          res.json({
            service: 'tonight-play-time',
            schema_version: version.user_version,
            database_integrity: Object.values(integrity || {})[0] || 'unknown',
            pending_conflicts: conflicts?.count || 0,
            backup_count: backups.length,
            latest_backup: backups[0] || null,
            uptime_seconds: Math.floor(process.uptime())
          });
        }
      );
    });
  });
});

app.get('/api/health', (req, res) => {
  db.get('SELECT 1 AS ok', (error) => {
    res.status(error ? 503 : 200).json({
      status: error ? 'degraded' : 'ok',
      service: 'tonight-play-time',
      database: error ? 'unavailable' : 'ok'
    });
  });
});

// Explicit public allowlist: source, deployment files, and databases are never
// reachable from the web server.
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
  ['/time-utils.js', 'time-utils.js'],
  ['/app.js', 'app.js'],
  ['/api-service.js', 'api-service.js'],
  ['/service-worker.js', 'service-worker.js'],
  ['/manifest.json', 'manifest.json']
]);

for (const [route, filename] of PUBLIC_FILES) {
  app.get(route, (req, res) => res.sendFile(path.join(APP_ROOT, filename)));
}
app.use('/icons', express.static(path.join(APP_ROOT, 'icons'), {
  dotfiles: 'deny',
  fallthrough: false,
  index: false,
  maxAge: '1d'
}));

app.use((req, res) => {
  res.status(404).json({ detail: '资源不存在' });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && Object.prototype.hasOwnProperty.call(error, 'body')) {
    return res.status(400).json({ detail: 'JSON 格式不正确' });
  }
  if (error.status === 404) return res.status(404).json({ detail: '资源不存在' });
  console.error('Unhandled request error:', error);
  return res.status(500).json({ detail: '服务器内部错误' });
});

let server;
function startServer(port = PORT) {
  if (server) return server;
  server = app.listen(port, '0.0.0.0', () => {
    const address = server.address();
    console.log(`🌙 今晚还能玩多久 API running on port ${address.port}`);
    console.log(`🔗 http://localhost:${address.port}`);
  });
  server.once('close', () => {
    server = null;
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { app, db, databaseReady, startServer };
