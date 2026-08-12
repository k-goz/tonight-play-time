const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool, types } = require('pg');

// Keep API responses compatible with SQLite. Node-postgres otherwise returns
// bigint/count values as strings and timestamps as Date objects.
types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));
types.setTypeParser(1114, value => value);
types.setTypeParser(1184, value => value);

function postgresError(error) {
  if (error?.code === '23505') {
    error.postgresCode = error.code;
    error.code = 'SQLITE_CONSTRAINT';
  }
  return error;
}

function placeholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function returningId(sql) {
  if (!/^\s*INSERT\s+INTO\s+/i.test(sql) || /\bRETURNING\b/i.test(sql)) return sql;
  const table = sql.match(/^\s*INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/i)?.[1]?.toLowerCase();
  const identityTables = new Set([
    'users', 'child_profiles', 'homework_sessions', 'weekly_rewards',
    'streak_protections', 'reminder_events', 'sync_conflicts', 'audit_logs',
    'product_events'
  ]);
  return identityTables.has(table) ? `${sql.trim().replace(/;$/, '')} RETURNING id` : sql;
}

function normalizeStatement(sql, { insertId = false } = {}) {
  const normalized = /^\s*BEGIN\s+IMMEDIATE\s*;?\s*$/i.test(sql) ? 'BEGIN' : sql;
  return placeholders(insertId ? returningId(normalized) : normalized);
}

function normalizeArgs(params, callback) {
  if (typeof params === 'function') return { params: [], callback: params };
  return {
    params: (params || []).map(value => typeof value === 'boolean' ? (value ? 1 : 0) : value),
    callback
  };
}

function createPostgresDatabase(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required for PostgreSQL');

  const connectionUrl = new URL(connectionString);
  connectionUrl.searchParams.delete('sslmode');

  const pool = new Pool({
    connectionString: connectionUrl.toString(),
    ssl: { rejectUnauthorized: true },
    max: Number(process.env.POSTGRES_POOL_MAX) || 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 20_000,
    allowExitOnIdle: process.env.NODE_ENV !== 'production'
  });
  const transactionStorage = new AsyncLocalStorage();

  const activeClient = () => transactionStorage.getStore()?.client || pool;

  const database = {
    dialect: 'postgres',
    configure() {},
    serialize(callback) { callback(); },

    run(sql, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      const statement = sql.trim();

      if (/^BEGIN(?:\s+IMMEDIATE)?\s*;?$/i.test(statement)) {
        pool.connect().then(async client => {
          await client.query('BEGIN');
          transactionStorage.run({ client }, () => callback?.call({ changes: 0 }));
        }).catch(error => callback?.call({ changes: 0 }, postgresError(error)));
        return database;
      }

      const transaction = transactionStorage.getStore();
      const endsTransaction = /^(COMMIT|ROLLBACK)\s*;?$/i.test(statement);
      activeClient().query(normalizeStatement(sql, { insertId: true }), params)
        .then(result => {
          const context = {
            lastID: result.rows?.[0]?.id,
            changes: result.rowCount || 0
          };
          if (endsTransaction && transaction?.client) transaction.client.release();
          callback?.call(context, null);
        })
        .catch(error => {
          if (endsTransaction && transaction?.client) transaction.client.release();
          callback?.call({ changes: 0 }, postgresError(error));
        });
      return database;
    },

    get(sql, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      activeClient().query(normalizeStatement(sql), params)
        .then(result => callback?.(null, result.rows[0]))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    all(sql, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      activeClient().query(normalizeStatement(sql), params)
        .then(result => callback?.(null, result.rows))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    exec(sql, callback) {
      activeClient().query(sql)
        .then(() => callback?.(null))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    async withClient(callback) {
      const client = await pool.connect();
      try {
        return await callback(client);
      } finally {
        client.release();
      }
    },

    async transaction(statements, callback) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const results = [];
        for (const item of statements) {
          results.push(await client.query(
            normalizeStatement(item.sql, { insertId: Boolean(item.insertId) }),
            (item.params || []).map(value => typeof value === 'boolean' ? (value ? 1 : 0) : value)
          ));
        }
        await client.query('COMMIT');
        callback?.(null, results);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        callback?.(postgresError(error));
      } finally {
        client.release();
      }
    },

    close(callback) {
      pool.end().then(() => callback?.(null)).catch(error => callback?.(error));
    }
  };

  pool.on('error', error => console.error('PostgreSQL pool error:', error.message));
  return database;
}

module.exports = { createPostgresDatabase, normalizeStatement };
