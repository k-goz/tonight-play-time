const { neon, types } = require('@neondatabase/serverless');
const { normalizeStatement } = require('./postgres-db');

types.setTypeParser(20, value => Number(value));
types.setTypeParser(1700, value => Number(value));
types.setTypeParser(1114, value => value);
types.setTypeParser(1184, value => value);

function normalizeParams(params = []) {
  return params.map(value => typeof value === 'boolean' ? (value ? 1 : 0) : value);
}

function normalizeArgs(params, callback) {
  if (typeof params === 'function') return { params: [], callback: params };
  return { params: normalizeParams(params || []), callback };
}

function postgresError(error) {
  if (error?.code === '23505') {
    error.postgresCode = error.code;
    error.code = 'SQLITE_CONSTRAINT';
  }
  return error;
}

function schemaStatements(schemaSql) {
  return schemaSql.split(';').map(statement => statement.trim()).filter(Boolean);
}

function isRetryableConnectionError(error) {
  const retryableCodes = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'
  ]);
  let current = error;
  while (current) {
    if (retryableCodes.has(current.code)) return true;
    const message = String(current.message || '');
    if (/fetch failed|error connecting to database|socket.*closed|network/i.test(message)) return true;
    current = current.cause;
  }
  return false;
}

async function withTransientRetry(operation, { attempts = 4, delayMs = 100 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableConnectionError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
    }
  }
  throw lastError;
}

function createNeonHttpDatabase(connectionString) {
  const sql = neon(connectionString, { fullResults: true, types });

  async function query(statement, params = [], insertId = false) {
    const normalizedStatement = normalizeStatement(statement, { insertId });
    const execute = () => sql.query(
      normalizedStatement,
      normalizeParams(params),
      { fullResults: true }
    );
    // Retrying a write after a lost HTTP response can duplicate side effects.
    // Reads are safe to retry and cover auth lookups, dashboards, and health.
    return /^\s*(SELECT|SHOW)\b/i.test(normalizedStatement)
      ? withTransientRetry(execute)
      : execute();
  }

  const database = {
    dialect: 'postgres-http',
    configure() {},
    serialize(callback) { callback(); },

    run(statement, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      query(statement, params, true)
        .then(result => callback?.call({
          lastID: result.rows?.[0]?.id,
          changes: result.rowCount || 0
        }, null))
        .catch(error => callback?.call({ changes: 0 }, postgresError(error)));
      return database;
    },

    get(statement, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      query(statement, params)
        .then(result => callback?.(null, result.rows[0]))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    all(statement, params, callback) {
      ({ params, callback } = normalizeArgs(params, callback));
      query(statement, params)
        .then(result => callback?.(null, result.rows))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    exec(schemaSql, callback) {
      const queries = schemaStatements(schemaSql).map(statement => sql.query(statement, [], { fullResults: true }));
      sql.transaction(queries, { fullResults: true })
        .then(() => callback?.(null))
        .catch(error => callback?.(postgresError(error)));
      return database;
    },

    transaction(statements, callback) {
      const queries = statements.map(item => sql.query(
        normalizeStatement(item.sql, { insertId: Boolean(item.insertId) }),
        normalizeParams(item.params || []),
        { fullResults: true }
      ));
      sql.transaction(queries, { fullResults: true })
        .then(results => callback?.(null, results))
        .catch(error => callback?.(postgresError(error)));
    },

    async initializeSchema(schemaSql, version) {
      await withTransientRetry(async () => {
        const current = await query(`
          SELECT CASE WHEN to_regclass('public.schema_migrations') IS NULL THEN 0
            ELSE COALESCE((SELECT MAX(version) FROM schema_migrations), 0)
          END AS version
        `);
        if (Number(current.rows[0]?.version) >= version) return;
        const statements = [
          'SELECT pg_advisory_xact_lock(8311042)',
          ...schemaStatements(schemaSql)
        ];
        await sql.transaction(
          statements.map(statement => sql.query(statement, [], { fullResults: true })),
          { fullResults: true }
        );
      });
    },

    close(callback) { callback?.(null); }
  };

  return database;
}

module.exports = {
  createNeonHttpDatabase,
  isRetryableConnectionError,
  withTransientRetry
};
