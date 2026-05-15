const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = 8001;

// Middleware
app.use(cors());
app.use(express.json());

// Database setup
const db = new sqlite3.Database('./tonight_play_time.db');

// Create tables
db.serialize(() => {
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
    start_time DATETIME,
    end_time DATETIME,
    completed BOOLEAN DEFAULT 0,
    homework_done BOOLEAN DEFAULT 0,
    correction_done BOOLEAN DEFAULT 0,
    attitude_good BOOLEAN DEFAULT 0,
    playtime_type TEXT,
    playtime_minutes REAL DEFAULT 0,
    bedtime TEXT DEFAULT '21:30',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);
});

// Simple password hashing (for demo - use bcrypt in production)
const crypto = require('crypto');
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Simple JWT-like token (for demo)
const tokens = new Map();
function createToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { userId, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 });
  return token;
}

function verifyToken(token) {
  const data = tokens.get(token);
  if (!data || data.expires < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return data.userId;
}

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ detail: '未登录' });
  
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ detail: '登录已过期' });
  
  req.userId = userId;
  next();
}

// ==================== Auth Routes ====================

app.post('/api/auth/register', (req, res) => {
  const { username, nickname, password } = req.body;
  
  if (!username || !nickname || !password) {
    return res.status(400).json({ detail: '请填写所有字段' });
  }

  db.get('SELECT id FROM users WHERE username = ?', [username], (err, row) => {
    if (row) return res.status(400).json({ detail: '用户名已存在' });

    const hash = hashPassword(password);
    db.run('INSERT INTO users (username, nickname, password_hash) VALUES (?, ?, ?)',
      [username, nickname, hash], function(err) {
        if (err) return res.status(500).json({ detail: '注册失败' });

        const token = createToken(this.lastID);
        res.json({
          access_token: token,
          user_id: this.lastID,
          nickname
        });
      });
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;

  db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ detail: '用户名或密码错误' });
    }

    const token = createToken(user.id);
    res.json({
      access_token: token,
      user_id: user.id,
      nickname: user.nickname
    });
  });
});

app.get('/api/auth/me', auth, (req, res) => {
  db.get('SELECT id, username, nickname FROM users WHERE id = ?', [req.userId], (err, user) => {
    if (!user) return res.status(404).json({ detail: '用户不存在' });
    res.json({ user_id: user.id, username: user.username, nickname: user.nickname });
  });
});

// ==================== Session Routes ====================

app.post('/api/sessions', auth, (req, res) => {
  const { date, bedtime } = req.body;

  db.get('SELECT id FROM homework_sessions WHERE user_id = ? AND date = ?',
    [req.userId, date], (err, existing) => {
      if (existing) return res.status(400).json({ detail: '今天已有记录' });

      db.run('INSERT INTO homework_sessions (user_id, date, bedtime) VALUES (?, ?, ?)',
        [req.userId, date, bedtime || '21:30'], function(err) {
          if (err) return res.status(500).json({ detail: '创建失败' });

          db.get('SELECT * FROM homework_sessions WHERE id = ?', [this.lastID], (err, session) => {
            res.json(session);
          });
        });
    });
});

app.get('/api/sessions', auth, (req, res) => {
  const limit = req.query.limit || 30;
  db.all('SELECT * FROM homework_sessions WHERE user_id = ? ORDER BY date DESC LIMIT ?',
    [req.userId, limit], (err, sessions) => {
      res.json(sessions || []);
    });
});

app.put('/api/sessions/:id', auth, (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  db.get('SELECT * FROM homework_sessions WHERE id = ? AND user_id = ?',
    [id, req.userId], (err, session) => {
      if (!session) return res.status(404).json({ detail: '记录不存在' });

      const fields = [];
      const values = [];
      
      Object.keys(updates).forEach(key => {
        if (updates[key] !== undefined) {
          fields.push(`${key} = ?`);
          values.push(updates[key]);
        }
      });

      if (fields.length === 0) return res.json(session);

      fields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id, req.userId);

      db.run(`UPDATE homework_sessions SET ${fields.join(', ')} WHERE id = ? AND user_id = ?`,
        values, function(err) {
          if (err) return res.status(500).json({ detail: '更新失败' });

          db.get('SELECT * FROM homework_sessions WHERE id = ?', [id], (err, updated) => {
            res.json(updated);
          });
        });
    });
});

app.delete('/api/sessions/:id', auth, (req, res) => {
  const { id } = req.params;

  db.get('SELECT * FROM homework_sessions WHERE id = ? AND user_id = ?',
    [id, req.userId], (err, session) => {
      if (!session) return res.status(404).json({ detail: '记录不存在' });

      db.run('DELETE FROM homework_sessions WHERE id = ? AND user_id = ?',
        [id, req.userId], function(err) {
          if (err) return res.status(500).json({ detail: '删除失败' });
          res.json({ message: '已删除' });
        });
    });
});

// ==================== Stats Routes ====================

app.get('/api/stats', auth, (req, res) => {
  const days = req.query.days || 30;
  const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  db.all('SELECT * FROM homework_sessions WHERE user_id = ? AND date >= ?',
    [req.userId, cutoffDate], (err, sessions) => {
      const total = sessions.length;
      const totalHomework = sessions.reduce((sum, s) => sum + (s.homework_minutes || 0), 0);
      const totalPlaytime = sessions.reduce((sum, s) => sum + (s.playtime_minutes || 0), 0);
      const completed = sessions.filter(s => s.completed).length;
      const stars = sessions.filter(s => s.completed && s.homework_done && s.correction_done && s.attitude_good).length;

      res.json({
        total_sessions: total,
        total_homework_minutes: totalHomework,
        avg_homework_minutes: total > 0 ? totalHomework / total : 0,
        total_playtime_minutes: totalPlaytime,
        completion_rate: total > 0 ? completed / total : 0,
        star_days: stars
      });
    });
});

// ==================== Health Check ====================

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'tonight-play-time' });
});

// ==================== Serve Static Files ====================

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌙 今晚还能玩多久 API running on port ${PORT}`);
  console.log(`🔗 http://localhost:${PORT}`);
});
