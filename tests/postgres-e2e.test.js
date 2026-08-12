const test = require('node:test');
const assert = require('node:assert/strict');

const enabled = process.env.RUN_POSTGRES_TESTS === '1' && Boolean(process.env.POSTGRES_URL || process.env.DATABASE_URL);

if (!enabled) {
  test('PostgreSQL cloud integration (set RUN_POSTGRES_TESTS=1)', { skip: true }, () => {});
} else {
  const { db, databaseReady, startServer } = require('../backend/server');
  const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const usernames = [`m11_${suffix}`, `m11_other_${suffix}`];
  let server;
  let baseUrl;

  async function api(pathname, options = {}) {
    const response = await fetch(`${baseUrl}${pathname}`, options);
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { response, body };
  }

  async function cleanup() {
    for (const username of usernames) {
      await new Promise((resolve, reject) => {
        db.run(
          'DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE username = ?)',
          [username],
          error => error ? reject(error) : resolve()
        );
      });
      await new Promise((resolve, reject) => {
        db.run('DELETE FROM users WHERE username = ?', [username], error => error ? reject(error) : resolve());
      });
    }
  }

  test.before(async () => {
    await databaseReady;
    server = startServer(0);
    if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  test.after(async () => {
    await cleanup();
    if (server?.listening) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  });

  test('PostgreSQL supports the complete cloud family lifecycle and tenant isolation', async () => {
    const health = await api('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.body.database_dialect, 'postgres');
    assert.equal(health.body.schema_version, 6);

    const registration = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernames[0], nickname: '云端孩子', password: 'M11-cloud-pass-2026' })
    });
    assert.equal(registration.response.status, 201);
    const childId = registration.body.child_id;
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${registration.body.access_token}`
    };

    const parentGrant = await api('/api/settings/verify-pin', {
      method: 'POST', headers,
      body: JSON.stringify({ parent_pin: '1234', purpose: 'manage' })
    });
    assert.equal(parentGrant.response.status, 200);
    const parentHeaders = { ...headers, 'X-Parent-Token': parentGrant.body.parent_token };

    const settings = await api('/api/settings', {
      method: 'PUT', headers: parentHeaders,
      body: JSON.stringify({ bedtime: '22:00', weekend_bedtime: '22:30', parent_pin: '4321' })
    });
    assert.equal(settings.response.status, 200);

    const secondChild = await api('/api/children', {
      method: 'POST', headers: parentHeaders,
      body: JSON.stringify({ name: '星星', avatar: '⭐', bedtime: '21:40', weekend_bedtime: '22:10' })
    });
    assert.equal(secondChild.response.status, 201);

    const imported = await api('/api/sessions/import', {
      method: 'POST', headers: parentHeaders,
      body: JSON.stringify({
        child_id: childId,
        records: [{
          date: '2026-08-12', bedtime: '22:00', homework_seconds: 1200,
          paused_seconds: 60, remaining_seconds: 1800, homework_done: true,
          correction_done: true, attitude_good: true, title: '云端迁移', reward_choice: '阅读'
        }]
      })
    });
    assert.equal(imported.response.status, 200);
    assert.equal(imported.body.imported, 1);

    const created = await api('/api/sessions', {
      method: 'POST', headers,
      body: JSON.stringify({ child_id: childId, date: '2026-08-13', bedtime: '22:00' })
    });
    assert.equal(created.response.status, 201);

    const approval = await api('/api/settings/verify-pin', {
      method: 'POST', headers,
      body: JSON.stringify({ parent_pin: '4321', purpose: 'approve' })
    });
    const completed = await api(`/api/sessions/${created.body.id}`, {
      method: 'PUT',
      headers: { ...headers, 'X-Parent-Approval': approval.body.approval_token },
      body: JSON.stringify({
        client_version: created.body.version,
        state: 'completed', completed: true, homework_done: true,
        correction_done: true, attitude_good: true, homework_seconds: 600,
        homework_minutes: 10, remaining_seconds: 1800, playtime_minutes: 30
      })
    });
    assert.equal(completed.response.status, 200);
    assert.equal(completed.body.completed, 1);
    assert.equal(completed.body.version, 2);

    const otherRegistration = await api('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernames[1], nickname: '隔离账号', password: 'M11-other-pass-2026' })
    });
    const otherHeaders = { Authorization: `Bearer ${otherRegistration.body.access_token}` };
    const forbidden = await api(`/api/sessions?child_id=${childId}`, { headers: otherHeaders });
    assert.equal(forbidden.response.status, 404);

    // A new token simulates another browser/function instance reading durable data.
    const login = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: usernames[0], password: 'M11-cloud-pass-2026' })
    });
    assert.equal(login.response.status, 200);
    const restored = await api(`/api/sessions?child_id=${childId}&limit=30`, {
      headers: { Authorization: `Bearer ${login.body.access_token}` }
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body.length, 2);
    assert.equal(restored.body.find(row => row.date === '2026-08-13').state, 'completed');
  });
}
