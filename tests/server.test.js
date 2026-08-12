const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tonight-play-time-test-'));
process.env.DATABASE_PATH = path.join(testDirectory, 'app.db');

const { db, startServer } = require('../backend/server');

let server;
let baseUrl;

async function startTestServer() {
  server = startServer(0);
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopTestServer() {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => null);
  return { response, body };
}

test.before(async () => {
  await startTestServer();
});

test.after(async () => {
  await stopTestServer();
  await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

test('only explicitly public frontend files are served', async () => {
  const publicResponse = await fetch(`${baseUrl}/index.html`);
  assert.equal(publicResponse.status, 200);
  assert.match(publicResponse.headers.get('content-type'), /text\/html/);
  assert.match(publicResponse.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(publicResponse.headers.get('x-content-type-options'), 'nosniff');

  for (const pathname of ['/deploy.sh', '/backend/server.js', '/backend/data/app.db']) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assert.match(response.headers.get('content-type'), /application\/json/);
  }
});

test('authenticated session lifecycle persists and rejects unapproved fields', async () => {
  const registration = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_child', nickname: '小月亮', password: 'test1234' })
  });
  assert.equal(registration.response.status, 201);
  const token = registration.body.access_token;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const created = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: '2026-08-12', bedtime: '21:30' })
  });
  assert.equal(created.response.status, 201);

  const repeated = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: '2026-08-12', bedtime: '21:30' })
  });
  assert.equal(repeated.response.status, 201);
  assert.equal(repeated.body.id, created.body.id);

  const forbiddenUpdate = await api(`/api/sessions/${created.body.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ user_id: 999 })
  });
  assert.equal(forbiddenUpdate.response.status, 400);

  const malformedJson = await fetch(`${baseUrl}/api/sessions/${created.body.id}`, {
    method: 'PUT',
    headers,
    body: '{not-json}'
  });
  assert.equal(malformedJson.status, 400);
  assert.match(malformedJson.headers.get('content-type'), /application\/json/);

  const completed = await api(`/api/sessions/${created.body.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      state: 'completed',
      homework_seconds: 600,
      homework_minutes: 10,
      completed: true,
      homework_done: true,
      correction_done: true,
      attitude_good: true,
      remaining_seconds: 1800,
      playtime_minutes: 30,
      title: '时间小管家'
    })
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.completed, 1);
  assert.equal(completed.body.homework_seconds, 600);

  await stopTestServer();
  await startTestServer();

  const restored = await api('/api/sessions?limit=30', { headers });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.length, 1);
  assert.equal(restored.body[0].state, 'completed');
});

test('logout revokes the bearer token', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_child', password: 'test1234' })
  });
  assert.equal(login.response.status, 200);
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.access_token}` };

  const logout = await api('/api/auth/logout', { method: 'POST', headers });
  assert.equal(logout.response.status, 200);

  const me = await api('/api/auth/me', { headers });
  assert.equal(me.response.status, 401);
});
