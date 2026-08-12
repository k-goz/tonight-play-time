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

db.serialize(() => {
  db.run('PRAGMA foreign_keys = ON');
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    nickname TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    pin_code TEXT DEFAULT '1234',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

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
  db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_date ON homework_sessions(user_id, date)');

  db.run(`CREATE TABLE IF NOT EXISTS auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id)');
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

function validDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function validBedtime(bedtime) {
  return typeof bedtime === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(bedtime);
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
      'INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)',
      [username, nickname, hashPassword(password)],
      function onInsert(insertError) {
        if (insertError) {
          if (insertError.code === 'SQLITE_CONSTRAINT') {
            return res.status(400).json({ detail: '用户名已存在' });
          }
          return res.status(500).json({ detail: '注册失败' });
        }

        const userId = this.lastID;
        createToken(userId, (tokenError, token) => {
          if (tokenError) return res.status(500).json({ detail: '登录状态创建失败' });
          res.status(201).json({ access_token: token, user_id: userId, nickname });
        });
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
  db.run('DELETE FROM auth_tokens WHERE token_hash = ?', [req.tokenHash], (error) => {
    if (error) return res.status(500).json({ detail: '退出失败' });
    res.json({ message: '已退出' });
  });
});

app.get('/api/auth/me', auth, (req, res) => {
  db.get('SELECT id, username, nickname FROM users WHERE id = ?', [req.userId], (error, user) => {
    if (error) return res.status(500).json({ detail: '用户信息读取失败' });
    if (!user) return res.status(404).json({ detail: '用户不存在' });
    res.json({ user_id: user.id, username: user.username, nickname: user.nickname });
  });
});

app.post('/api/sessions', auth, (req, res) => {
  const { date, bedtime = '21:30' } = req.body;
  if (!validDate(date) || !validBedtime(bedtime)) {
    return res.status(400).json({ detail: '日期或睡觉时间格式不正确' });
  }

  db.run(
    `INSERT INTO homework_sessions (user_id, date, bedtime, state)
     VALUES (?, ?, ?, 'idle')
     ON CONFLICT(user_id, date) DO UPDATE SET bedtime = excluded.bedtime, updated_at = CURRENT_TIMESTAMP`,
    [req.userId, date, bedtime],
    (error) => {
      if (error) return res.status(500).json({ detail: '创建失败' });
      db.get(
        'SELECT * FROM homework_sessions WHERE user_id = ? AND date = ?',
        [req.userId, date],
        (readError, session) => {
          if (readError) return res.status(500).json({ detail: '记录读取失败' });
          res.status(201).json(session);
        }
      );
    }
  );
});

app.get('/api/sessions', auth, (req, res) => {
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 30;
  db.all(
    'SELECT * FROM homework_sessions WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    [req.userId, limit],
    (error, sessions) => {
      if (error) return res.status(500).json({ detail: '记录读取失败' });
      res.json(sessions || []);
    }
  );
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
    }
  );
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: '记录编号不正确' });

  db.run(
    'DELETE FROM homework_sessions WHERE id = ? AND user_id = ?',
    [id, req.userId],
    function onDelete(error) {
      if (error) return res.status(500).json({ detail: '删除失败' });
      if (this.changes === 0) return res.status(404).json({ detail: '记录不存在' });
      res.json({ message: '已删除' });
    }
  );
});

app.get('/api/stats', auth, (req, res) => {
  const requestedDays = Number.parseInt(req.query.days, 10);
  const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 365) : 30;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  db.all(
    'SELECT * FROM homework_sessions WHERE user_id = ? AND date >= ?',
    [req.userId, cutoffDate],
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

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tonight-play-time' });
});

// Explicit public allowlist: source, deployment files, and databases are never
// reachable from the web server.
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
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

module.exports = { app, db, startServer };
