const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { TABLES, createPool, resetIdentitySequences } = require('./postgres-utils');

const gunzip = promisify(zlib.gunzip);
const backupArgument = process.argv[2];
if (!backupArgument || !process.argv.includes('--confirm')) {
  console.error('Usage: npm run db:restore:postgres -- /absolute/path/backup.json.gz --confirm');
  process.exit(1);
}

const backupPath = path.resolve(backupArgument);
if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) {
  console.error(`Backup not found: ${backupPath}`);
  process.exit(1);
}

async function main() {
  const raw = await gunzip(fs.readFileSync(backupPath));
  const backup = JSON.parse(raw.toString('utf8'));
  if (backup.format !== 'tonight-play-time-postgres-backup' || backup.schema_version !== 6) {
    throw new Error('Unsupported or damaged PostgreSQL backup');
  }
  if (!backup.tables || TABLES.some(table => !Array.isArray(backup.tables[table]))) {
    throw new Error('Backup table set is incomplete');
  }

  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '60s'");
    const occupied = [];
    for (const table of [...TABLES].reverse()) {
      const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
      if (result.rows[0].count > 0) occupied.push(table);
    }
    if (occupied.length > 0) {
      throw new Error(`Restore target must be empty; occupied tables: ${occupied.join(', ')}`);
    }

    const restored = {};
    for (const table of TABLES) {
      restored[table] = 0;
      const targetColumns = await client.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table]
      );
      const allowed = new Set(targetColumns.rows.map(row => row.column_name));
      for (const row of backup.tables[table]) {
        const columns = Object.keys(row);
        if (columns.length === 0) continue;
        if (columns.some(column => !allowed.has(column))) {
          throw new Error(`Backup contains an unsupported ${table} column`);
        }
        const values = columns.map(column => row[column]);
        const placeholders = columns.map((_, index) => `$${index + 1}`);
        const result = await client.query(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
          values
        );
        restored[table] += result.rowCount;
      }
    }
    await resetIdentitySequences(client);
    await client.query('COMMIT');
    console.log(JSON.stringify({ restored: true, backup: backupPath, rows: restored }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`PostgreSQL restore failed: ${error.message}`);
  process.exitCode = 1;
});
