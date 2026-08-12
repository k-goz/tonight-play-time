const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

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

async function parentHeaders(headers, pin) {
  const grant = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: pin, purpose: 'manage' })
  });
  assert.equal(grant.response.status, 200);
  assert.equal(grant.body.valid, true);
  assert.match(grant.body.parent_token, /^[a-f0-9]{64}$/);
  return { ...headers, 'X-Parent-Token': grant.body.parent_token };
}

async function approvalToken(headers, pin) {
  const grant = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: pin, purpose: 'approve' })
  });
  assert.equal(grant.response.status, 200);
  assert.equal(grant.body.valid, true);
  assert.match(grant.body.approval_token, /^[a-f0-9]{64}$/);
  return grant.body.approval_token;
}

async function runSql(sql, params = []) {
  await new Promise((resolve, reject) => {
    db.run(sql, params, (error) => error ? reject(error) : resolve());
  });
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

  const initialSettings = await api('/api/settings', { headers });
  assert.equal(initialSettings.response.status, 200);
  assert.equal(initialSettings.body.initialized, false);
  assert.equal(initialSettings.body.pin_configured, false);
  assert.equal(Object.hasOwn(initialSettings.body, 'parent_pin'), false);

  const defaultPin = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: '1234' })
  });
  assert.equal(defaultPin.body.valid, true);
  const initialParentHeaders = {
    ...headers,
    'X-Parent-Token': defaultPin.body.parent_token
  };

  const savedSettings = await api('/api/settings', {
    method: 'PUT',
    headers: initialParentHeaders,
    body: JSON.stringify({ bedtime: '22:00', weekend_bedtime: '22:30', parent_pin: '4321' })
  });
  assert.equal(savedSettings.response.status, 200);

  const updatedSettings = await api('/api/settings', { headers });
  assert.equal(updatedSettings.body.bedtime, '22:00');
  assert.equal(updatedSettings.body.weekend_bedtime, '22:30');
  assert.equal(updatedSettings.body.initialized, true);

  const oldPin = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: '1234' })
  });
  const newPin = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: '4321' })
  });
  assert.equal(oldPin.body.valid, false);
  assert.equal(newPin.body.valid, true);

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
    headers: {
      ...headers,
      'X-Parent-Approval': await approvalToken(headers, '4321')
    },
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

test('legacy default PIN can initialize while a custom PIN is preserved', async () => {
  const legacyPassword = crypto.createHash('sha256').update('legacy123').digest('hex');
  await runSql(
    'INSERT INTO users (username, nickname, password_hash, pin_code) VALUES (?, ?, ?, ?)',
    ['legacy_default', '旧默认账号', legacyPassword, '1234']
  );
  await runSql(
    'INSERT INTO users (username, nickname, password_hash, pin_code) VALUES (?, ?, ?, ?)',
    ['legacy_child', '旧账号', legacyPassword, '9876']
  );

  const defaultLogin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'legacy_default', password: 'legacy123' })
  });
  const defaultSettings = await api('/api/settings', {
    headers: { Authorization: `Bearer ${defaultLogin.body.access_token}` }
  });
  assert.equal(defaultSettings.body.initialized, false);
  assert.equal(defaultSettings.body.pin_configured, false);

  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'legacy_child', password: 'legacy123' })
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.access_token}` };

  const initialSettings = await api('/api/settings', { headers });
  assert.equal(initialSettings.body.initialized, false);
  assert.equal(initialSettings.body.pin_configured, true);

  const legacyParentHeaders = await parentHeaders(headers, '9876');

  const bedtimeOnly = await api('/api/settings', {
    method: 'PUT',
    headers: legacyParentHeaders,
    body: JSON.stringify({ bedtime: '21:45' })
  });
  assert.equal(bedtimeOnly.response.status, 200);

  const legacyPin = await api('/api/settings/verify-pin', {
    method: 'POST',
    headers,
    body: JSON.stringify({ parent_pin: '9876' })
  });
  assert.equal(legacyPin.body.valid, true);
});

test('local record import is idempotent and never overwrites completed server data', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_child', password: 'test1234' })
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.access_token}` };
  const importParentHeaders = await parentHeaders(headers, '4321');
  const localRecord = {
    date: '2026-08-11',
    bedtime: '22:00',
    start_time: '19:00:00',
    end_time: '19:20:00',
    homework_seconds: 1200,
    paused_seconds: 60,
    remaining_seconds: 9600,
    homework_done: true,
    correction_done: true,
    attitude_good: true,
    reward_choice: '亲子游戏',
    title: '时间小管家',
    call_it_a_day: false
  };

  const firstImport = await api('/api/sessions/import', {
    method: 'POST',
    headers: importParentHeaders,
    body: JSON.stringify({ records: [localRecord] })
  });
  assert.deepEqual(firstImport.body, { imported: 1, skipped: 0 });

  const repeatedImport = await api('/api/sessions/import', {
    method: 'POST',
    headers: importParentHeaders,
    body: JSON.stringify({ records: [{ ...localRecord, homework_seconds: 9999 }] })
  });
  assert.deepEqual(repeatedImport.body, { imported: 0, skipped: 1 });

  const sessions = await api('/api/sessions?limit=100', { headers });
  const imported = sessions.body.find(session => session.date === localRecord.date);
  assert.equal(imported.homework_seconds, 1200);

  const incomplete = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: '2026-08-10', bedtime: '21:30' })
  });
  assert.equal(incomplete.response.status, 201);
  assert.equal(incomplete.body.completed, 0);

  const completedLocalRecord = {
    ...localRecord,
    date: '2026-08-10',
    homework_seconds: 1800,
    homework_done: true,
    correction_done: false,
    attitude_good: true
  };
  const upgradedImport = await api('/api/sessions/import', {
    method: 'POST',
    headers: importParentHeaders,
    body: JSON.stringify({ records: [completedLocalRecord] })
  });
  assert.deepEqual(upgradedImport.body, { imported: 1, skipped: 0 });

  const upgradedSessions = await api('/api/sessions?limit=100', { headers });
  const upgraded = upgradedSessions.body.find(session => session.date === completedLocalRecord.date);
  assert.equal(upgraded.completed, 1);
  assert.equal(upgraded.homework_seconds, 1800);

  const secondUser = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other_child', nickname: '另一个孩子', password: 'test1234' })
  });
  const isolatedSessions = await api('/api/sessions?limit=100', {
    headers: { Authorization: `Bearer ${secondUser.body.access_token}` }
  });
  assert.deepEqual(isolatedSessions.body, []);
});

test('child profiles isolate sessions, keep separate rules, and archive without data loss', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_child', password: 'test1234' })
  });
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.body.access_token}` };
  const familyParentHeaders = await parentHeaders(headers, '4321');

  const initialChildren = await api('/api/children', { headers });
  assert.equal(initialChildren.response.status, 200);
  assert.equal(initialChildren.body.length, 1);
  const firstChild = initialChildren.body[0];
  assert.equal(firstChild.name, '小月亮');
  assert.equal(firstChild.is_default, 1);

  const secondChildResponse = await api('/api/children', {
    method: 'POST',
    headers: familyParentHeaders,
    body: JSON.stringify({
      name: '小太阳',
      avatar: '☀️',
      bedtime: '20:45',
      weekend_bedtime: '21:15'
    })
  });
  assert.equal(secondChildResponse.response.status, 201);
  const secondChild = secondChildResponse.body;
  assert.equal(secondChild.weekend_bedtime, '21:15');

  const firstSameDay = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ child_id: firstChild.id, date: '2026-08-08', bedtime: '22:00' })
  });
  const secondSameDay = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ child_id: secondChild.id, date: '2026-08-08', bedtime: '20:45' })
  });
  assert.equal(firstSameDay.response.status, 201);
  assert.equal(secondSameDay.response.status, 201);
  assert.notEqual(firstSameDay.body.id, secondSameDay.body.id);

  const firstSessions = await api(`/api/sessions?child_id=${firstChild.id}&limit=100`, { headers });
  const secondSessions = await api(`/api/sessions?child_id=${secondChild.id}&limit=100`, { headers });
  assert.equal(firstSessions.body.some(session => session.id === secondSameDay.body.id), false);
  assert.deepEqual(secondSessions.body.map(session => session.date), ['2026-08-08']);

  const updatedSettings = await api('/api/settings', {
    method: 'PUT',
    headers: familyParentHeaders,
    body: JSON.stringify({
      child_id: secondChild.id,
      bedtime: '20:30',
      weekend_bedtime: '21:30'
    })
  });
  assert.equal(updatedSettings.response.status, 200);
  const secondSettings = await api(`/api/settings?child_id=${secondChild.id}`, { headers });
  const firstSettings = await api(`/api/settings?child_id=${firstChild.id}`, { headers });
  assert.equal(secondSettings.body.bedtime, '20:30');
  assert.equal(secondSettings.body.weekend_bedtime, '21:30');
  assert.equal(firstSettings.body.bedtime, '22:00');
  assert.equal(firstSettings.body.weekend_bedtime, '22:30');

  const otherLogin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other_child', password: 'test1234' })
  });
  const otherHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${otherLogin.body.access_token}`
  };
  const otherParentHeaders = await parentHeaders(otherHeaders, '1234');
  const forbiddenChild = await api(`/api/sessions?child_id=${secondChild.id}`, {
    headers: otherHeaders
  });
  assert.equal(forbiddenChild.response.status, 404);
  const forbiddenChildUpdate = await api(`/api/children/${secondChild.id}`, {
    method: 'PUT',
    headers: otherParentHeaders,
    body: JSON.stringify({ name: '不应成功' })
  });
  assert.equal(forbiddenChildUpdate.response.status, 404);

  const forbiddenArchive = await api(`/api/children/${secondChild.id}/archive`, {
    method: 'POST',
    headers: otherParentHeaders,
    body: JSON.stringify({ archived: true })
  });
  assert.equal(forbiddenArchive.response.status, 404);

  const defaultArchive = await api(`/api/children/${firstChild.id}/archive`, {
    method: 'POST',
    headers: familyParentHeaders,
    body: JSON.stringify({ archived: true })
  });
  assert.equal(defaultArchive.response.status, 400);

  const archivedSecond = await api(`/api/children/${secondChild.id}/archive`, {
    method: 'POST',
    headers: familyParentHeaders,
    body: JSON.stringify({ archived: true })
  });
  assert.equal(archivedSecond.response.status, 200);
  assert.ok(archivedSecond.body.archived_at);

  const archivedSettings = await api(`/api/settings?child_id=${secondChild.id}`, { headers });
  const archivedSessions = await api(`/api/sessions?child_id=${secondChild.id}`, { headers });
  assert.equal(archivedSettings.response.status, 404);
  assert.equal(archivedSessions.response.status, 404);

  const childrenWithArchive = await api('/api/children', { headers });
  assert.equal(childrenWithArchive.body.at(-1).id, secondChild.id);
  assert.ok(childrenWithArchive.body.at(-1).archived_at);

  const restoredSecond = await api(`/api/children/${secondChild.id}/archive`, {
    method: 'POST',
    headers: familyParentHeaders,
    body: JSON.stringify({ archived: false })
  });
  assert.equal(restoredSecond.response.status, 200);
  assert.equal(restoredSecond.body.archived_at, null);
  const restoredSessions = await api(`/api/sessions?child_id=${secondChild.id}&limit=100`, { headers });
  assert.equal(restoredSessions.body.some(session => session.id === secondSameDay.body.id), true);

  const deletedSecond = await api(`/api/sessions?child_id=${secondChild.id}`, {
    method: 'DELETE',
    headers: familyParentHeaders
  });
  assert.equal(deletedSecond.body.deleted, 1);
  const firstAfterDelete = await api(`/api/sessions?child_id=${firstChild.id}&limit=100`, { headers });
  assert.equal(firstAfterDelete.body.some(session => session.date === '2026-08-08'), true);
});

test('parent grants enforce scope, revocation, and one-time completion approval', async () => {
  const registration = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'permission_family', nickname: '小盾牌', password: 'test1234' })
  });
  assert.equal(registration.response.status, 201);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${registration.body.access_token}`
  };

  const unapprovedChild = await api('/api/children', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: '不能添加', bedtime: '21:00' })
  });
  assert.equal(unapprovedChild.response.status, 403);
  const unapprovedStats = await api('/api/stats', { headers });
  assert.equal(unapprovedStats.response.status, 403);

  const oneTimeApproval = await approvalToken(headers, '1234');
  const wrongScope = await api('/api/children', {
    method: 'POST',
    headers: { ...headers, 'X-Parent-Token': oneTimeApproval },
    body: JSON.stringify({ name: '仍不能添加', bedtime: '21:00' })
  });
  assert.equal(wrongScope.response.status, 403);

  const managedHeaders = await parentHeaders(headers, '1234');
  const approvedChild = await api('/api/children', {
    method: 'POST',
    headers: managedHeaders,
    body: JSON.stringify({ name: '家长添加', bedtime: '21:00', weekend_bedtime: '22:00' })
  });
  assert.equal(approvedChild.response.status, 201);

  const locked = await api('/api/settings/parent-access', {
    method: 'DELETE',
    headers: managedHeaders
  });
  assert.equal(locked.response.status, 200);
  const revokedGrant = await api('/api/children', {
    method: 'POST',
    headers: managedHeaders,
    body: JSON.stringify({ name: '授权已撤销', bedtime: '21:00' })
  });
  assert.equal(revokedGrant.response.status, 403);

  const firstSession = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: '2026-08-06', bedtime: '21:00' })
  });
  const completionWithoutApproval = await api(`/api/sessions/${firstSession.body.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ state: 'completed', completed: true })
  });
  assert.equal(completionWithoutApproval.response.status, 403);

  const approvedCompletion = await api(`/api/sessions/${firstSession.body.id}`, {
    method: 'PUT',
    headers: { ...headers, 'X-Parent-Approval': oneTimeApproval },
    body: JSON.stringify({ state: 'completed', completed: true, homework_done: true })
  });
  assert.equal(approvedCompletion.response.status, 200);
  assert.equal(approvedCompletion.body.completed, 1);
  const completedDelete = await api(`/api/sessions/${firstSession.body.id}`, {
    method: 'DELETE',
    headers
  });
  assert.equal(completedDelete.response.status, 403);

  const rewardChoice = await api(`/api/sessions/${firstSession.body.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ reward_choice: '听故事' })
  });
  assert.equal(rewardChoice.response.status, 200);
  const completedRewrite = await api(`/api/sessions/${firstSession.body.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ title: '不能改写' })
  });
  assert.equal(completedRewrite.response.status, 403);

  const secondSession = await api('/api/sessions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ date: '2026-08-07', bedtime: '21:00' })
  });
  const reusedApproval = await api(`/api/sessions/${secondSession.body.id}`, {
    method: 'PUT',
    headers: { ...headers, 'X-Parent-Approval': oneTimeApproval },
    body: JSON.stringify({ state: 'completed', completed: true })
  });
  assert.equal(reusedApproval.response.status, 403);
});

test('M5-M10 family platform APIs persist preferences, reminders, growth, conflicts and validation intent', async () => {
  const registration = await api('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'platform_family', nickname: '小宇宙', password: 'platform1234' })
  });
  assert.equal(registration.response.status, 201);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${registration.body.access_token}`
  };
  const childId = registration.body.child_id;

  const preferences = await api('/api/family/preferences', { headers });
  assert.equal(preferences.body.allow_child_switch, false);
  const protectedPreferences = await api('/api/family/preferences', {
    method: 'PUT', headers, body: JSON.stringify({ allow_child_switch: true })
  });
  assert.equal(protectedPreferences.response.status, 403);
  const parent = await parentHeaders(headers, '1234');
  const savedPreferences = await api('/api/family/preferences', {
    method: 'PUT', headers: parent, body: JSON.stringify({ allow_child_switch: true })
  });
  assert.equal(savedPreferences.response.status, 200);
  assert.equal(savedPreferences.body.allow_child_switch, true);

  const childSettings = await api(`/api/children/${childId}`, {
    method: 'PUT',
    headers: parent,
    body: JSON.stringify({
      reminder_enabled: true,
      reminder_time: '19:15',
      weekend_reminder_time: '18:45',
      pause_reminder_minutes: 15,
      weekly_goal: 4,
      reward_text: '周末一起骑车'
    })
  });
  assert.equal(childSettings.response.status, 200);
  assert.equal(childSettings.body.reminder_enabled, 1);
  assert.equal(childSettings.body.weekend_reminder_time, '18:45');
  assert.equal(childSettings.body.weekly_goal, 4);

  const reminder = await api('/api/reminders/events', {
    method: 'POST', headers,
    body: JSON.stringify({ child_id: childId, event_type: 'test', status: 'delivered', detail: '测试触达' })
  });
  assert.equal(reminder.response.status, 201);
  const reminderEvents = await api(`/api/reminders/events?child_id=${childId}`, { headers: parent });
  assert.equal(reminderEvents.body[0].status, 'delivered');

  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const session = await api('/api/sessions', {
    method: 'POST', headers, body: JSON.stringify({ child_id: childId, date: today, bedtime: '21:30' })
  });
  assert.equal(session.body.version, 1);
  const racingUpdates = await Promise.all([
    api(`/api/sessions/${session.body.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ state: 'running', homework_seconds: 60, client_version: 1, device_id: 'device-a' })
    }),
    api(`/api/sessions/${session.body.id}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ state: 'paused', homework_seconds: 90, client_version: 1, device_id: 'device-b' })
    })
  ]);
  assert.deepEqual(racingUpdates.map(result => result.response.status).sort(), [200, 409]);
  const updated = racingUpdates.find(result => result.response.status === 200);
  const stale = racingUpdates.find(result => result.response.status === 409);
  assert.equal(updated.body.version, 2);
  assert.ok(stale.body.conflict_id > 0);
  const conflicts = await api('/api/sync/conflicts', { headers: parent });
  assert.equal(conflicts.body.length, 1);
  const resolved = await api(`/api/sync/conflicts/${stale.body.conflict_id}/resolve`, {
    method: 'POST', headers: parent, body: JSON.stringify({ resolution: 'server' })
  });
  assert.equal(resolved.body.resolved, true);

  const completion = await api(`/api/sessions/${session.body.id}`, {
    method: 'PUT',
    headers: { ...headers, 'X-Parent-Approval': await approvalToken(headers, '1234') },
    body: JSON.stringify({
      state: 'completed', completed: true, homework_done: true, correction_done: true,
      attitude_good: true, homework_minutes: 12, playtime_minutes: 25, client_version: 2
    })
  });
  assert.equal(completion.response.status, 200);
  const insights = await api(`/api/insights/weekly?child_id=${childId}`, { headers: parent });
  assert.equal(insights.body.goal, 4);
  assert.equal(insights.body.completed_days, 1);
  const todayDate = new Date(`${today}T12:00:00+08:00`);
  if (todayDate.getUTCDay() > 0) {
    todayDate.setUTCDate(todayDate.getUTCDate() - 1);
    const protectionDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(todayDate);
    const protection = await api('/api/growth/protection', {
      method: 'POST', headers: parent,
      body: JSON.stringify({ child_id: childId, date: protectionDate, reason: '生病休息' })
    });
    assert.equal(protection.response.status, 201);
    const repeatedProtection = await api('/api/growth/protection', {
      method: 'POST', headers: parent,
      body: JSON.stringify({ child_id: childId, date: protectionDate, reason: '重复保护' })
    });
    assert.equal(repeatedProtection.response.status, 400);
  }
  const reward = await api('/api/rewards/current', {
    method: 'PUT', headers: parent,
    body: JSON.stringify({ child_id: childId, reward_text: '周末一起骑车', status: 'approved' })
  });
  assert.equal(reward.body.status, 'approved');

  const plan = await api('/api/plan', { headers });
  assert.equal(plan.body.plan_tier, 'free');
  const intent = await api('/api/product-events', {
    method: 'POST', headers: parent,
    body: JSON.stringify({ event_type: 'purchase_intent', price_point: 1900, feedback: '愿意为周报付费' })
  });
  assert.equal(intent.response.status, 201);
  const trial = await api('/api/plan/trial', { method: 'POST', headers: parent, body: '{}' });
  assert.equal(trial.body.started, true);
  const metrics = await api('/api/product-metrics', { headers: parent });
  assert.equal(metrics.body.events[0].count, 1);
  assert.equal(metrics.body.funnel.activated, true);
  assert.equal(metrics.body.funnel.purchase_intent, true);

  const operations = await api('/api/operations/status', { headers: parent });
  assert.equal(operations.body.schema_version, 5);
  assert.equal(operations.body.database_integrity, 'ok');
  const logs = await api('/api/audit-logs', { headers: parent });
  assert.ok(logs.body.some(log => log.action === 'plan.trial_started'));
});

test('bulk record deletion is account-scoped and keeps the account', async () => {
  const firstLogin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'test_child', password: 'test1234' })
  });
  const secondLogin = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'other_child', password: 'test1234' })
  });
  const firstHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${firstLogin.body.access_token}` };
  const secondHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${secondLogin.body.access_token}` };
  const firstParentHeaders = await parentHeaders(firstHeaders, '4321');

  await api('/api/sessions', {
    method: 'POST',
    headers: secondHeaders,
    body: JSON.stringify({ date: '2026-08-09', bedtime: '21:30' })
  });

  const firstBeforeDelete = await api('/api/sessions?limit=100', { headers: firstHeaders });
  const deleted = await api('/api/sessions', { method: 'DELETE', headers: firstParentHeaders });
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.deleted, firstBeforeDelete.body.length);

  const firstSessions = await api('/api/sessions?limit=100', { headers: firstHeaders });
  const secondSessions = await api('/api/sessions?limit=100', { headers: secondHeaders });
  assert.deepEqual(firstSessions.body, []);
  assert.equal(secondSessions.body.length, 1);
  assert.equal(secondSessions.body[0].date, '2026-08-09');

  const firstAccount = await api('/api/auth/me', { headers: firstHeaders });
  assert.equal(firstAccount.response.status, 200);
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
