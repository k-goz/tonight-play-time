const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3').verbose();
const { Pool } = require('pg');

const sourceArgument = process.argv[2];
const confirmed = process.argv.includes('--confirm');
if (!sourceArgument || !confirmed) {
  console.error('Usage: npm run db:migrate:postgres -- /absolute/path/source.db --confirm');
  process.exit(1);
}

const sourcePath = path.resolve(sourceArgument);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  console.error(`SQLite source not found: ${sourcePath}`);
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
  process.exit(1);
}

const TABLES = [
  'users', 'child_profiles', 'homework_sessions', 'auth_tokens', 'parent_grants',
  'family_preferences', 'weekly_rewards', 'streak_protections', 'reminder_events',
  'sync_conflicts', 'audit_logs', 'product_events'
];
const IDENTITY_TABLES = TABLES.filter(table => !['auth_tokens', 'parent_grants', 'family_preferences'].includes(table));

function sqliteAll(database, sql, params = []) {
  return new Promise((resolve, reject) => database.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
}

function sqliteGet(database, sql, params = []) {
  return new Promise((resolve, reject) => database.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function closeSqlite(database) {
  return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}

function postgresPool(url) {
  const parsed = new URL(url);
  parsed.searchParams.delete('sslmode');
  return new Pool({ connectionString: parsed.toString(), ssl: { rejectUnauthorized: true }, max: 1 });
}

async function main() {
  // Reuse the production-tested V1→V5 SQLite migrations before copying rows.
  const childEnv = { ...process.env };
  for (const key of ['DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL']) delete childEnv[key];
  execFileSync(process.execPath, [path.join(__dirname, 'upgrade-sqlite.js'), sourcePath], {
    env: childEnv,
    stdio: 'inherit'
  });

  const sqlite = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY);
  const version = await sqliteGet(sqlite, 'PRAGMA user_version');
  if (version?.user_version !== 5) throw new Error(`Expected SQLite schema V5, got V${version?.user_version || 0}`);

  const pool = postgresPool(connectionString);
  const client = await pool.connect();
  const summary = {};
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");

    for (const table of TABLES) {
      const exists = await sqliteGet(
        sqlite,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table]
      );
      if (!exists) continue;
      const sourceRows = await sqliteAll(sqlite, `SELECT * FROM ${table}`);
      const targetColumns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const allowed = new Set(targetColumns.rows.map(row => row.column_name));
      let inserted = 0;
      for (const row of sourceRows) {
        const columns = Object.keys(row).filter(column => allowed.has(column));
        if (columns.length === 0) continue;
        const values = columns.map(column => row[column]);
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        const result = await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})
           ON CONFLICT DO NOTHING`,
          values
        );
        inserted += result.rowCount;
      }
      summary[table] = { source: sourceRows.length, inserted };
    }

    for (const table of IDENTITY_TABLES) {
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence($1, 'id'),
           GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), 1),
           EXISTS (SELECT 1 FROM ${table})
         )`,
        [table]
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({ migrated: true, sqlite_schema: 5, postgres_schema: 6, tables: summary }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
    await closeSqlite(sqlite);
  }
}

main().catch(error => {
  console.error(`Migration failed: ${error.message}`);
  process.exitCode = 1;
});
