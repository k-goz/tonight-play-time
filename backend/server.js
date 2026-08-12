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
    if (!error) return resolve();
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
      if (!error) return resolve();
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
    if (!error) return resolve();
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

app.post('/api/auth/login', (req, res) => {
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
    `SELECT id, name, avatar, bedtime, weekend_bedtime, is_default, archived_at,
       created_at, updated_at
     FROM child_profiles WHERE user_id = ?
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
          `SELECT id, name, avatar, bedtime, weekend_bedtime, is_default, archived_at,
             created_at, updated_at
           FROM child_profiles WHERE id = ? AND user_id = ?`,
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
  const allowed = new Set(['name', 'avatar', 'bedtime', 'weekend_bedtime']);
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
        `SELECT id, name, avatar, bedtime, weekend_bedtime, is_default, archived_at,
           created_at, updated_at
         FROM child_profiles WHERE id = ? AND user_id = ?`,
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
              `SELECT id, name, avatar, bedtime, weekend_bedtime, is_default, archived_at,
                 created_at, updated_at
               FROM child_profiles WHERE id = ? AND user_id = ?`,
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

app.post('/api/settings/verify-pin', auth, (req, res) => {
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

      if (!valid) return res.json({ valid: false });

      if (!user.parent_pin_hash) {
        db.run(
          'UPDATE users SET parent_pin_hash = ?, pin_code = NULL WHERE id = ?',
          [hashPassword(pin), req.userId]
        );
      }

      createParentGrant(req.userId, purpose, (grantError, grant) => {
        if (grantError) return res.status(500).json({ detail: '家长授权创建失败' });
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

  const updates = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
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

      const saveUpdates = () => {
        const assignments = keys.map((key) => `${key} = ?`);
        const values = keys.map((key) => updates[key]);
        assignments.push('updated_at = CURRENT_TIMESTAMP');
        values.push(id, req.userId);

        db.run(
          `UPDATE homework_sessions SET ${assignments.join(', ')} WHERE id = ? AND user_id = ?`,
          values,
          (updateError) => {
            if (updateError) return res.status(500).json({ detail: '更新失败' });
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tonight-play-time' });
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
