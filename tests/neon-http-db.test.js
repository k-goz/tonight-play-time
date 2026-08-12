const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isRetryableConnectionError,
  withTransientRetry
} = require('../backend/neon-http-db');

test('recognizes nested transient fetch/socket failures', () => {
  const error = new Error('Error connecting to database: TypeError: fetch failed', {
    cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
  });
  assert.equal(isRetryableConnectionError(error), true);
  assert.equal(isRetryableConnectionError(Object.assign(new Error('invalid query'), { code: '42601' })), false);
});

test('retries transient operations and preserves non-transient failures', async () => {
  let transientAttempts = 0;
  const result = await withTransientRetry(async () => {
    transientAttempts += 1;
    if (transientAttempts < 3) {
      throw Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' });
    }
    return 'ok';
  }, { attempts: 4, delayMs: 0 });

  assert.equal(result, 'ok');
  assert.equal(transientAttempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(() => withTransientRetry(async () => {
    permanentAttempts += 1;
    throw Object.assign(new Error('invalid query'), { code: '42601' });
  }, { attempts: 4, delayMs: 0 }), /invalid query/);
  assert.equal(permanentAttempts, 1);
});
