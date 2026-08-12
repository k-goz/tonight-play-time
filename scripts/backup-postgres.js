const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { TABLES, createPool } = require('./postgres-utils');

const gzip = promisify(zlib.gzip);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backend', 'backups', `postgres-${timestamp}.json.gz`));

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const tables = {};
    for (const table of TABLES) {
      const orderColumn = table === 'family_preferences' ? 'user_id' :
        ['auth_tokens', 'parent_grants'].includes(table) ? 'token_hash' : 'id';
      const result = await client.query(`SELECT * FROM ${table} ORDER BY ${orderColumn}`);
      tables[table] = result.rows;
    }
    await client.query('COMMIT');

    const document = {
      format: 'tonight-play-time-postgres-backup',
      schema_version: 6,
      created_at: new Date().toISOString(),
      tables
    };
    const compressed = await gzip(Buffer.from(JSON.stringify(document)));
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, compressed, { mode: 0o600 });
    console.log(JSON.stringify({
      backup: outputPath,
      bytes: compressed.length,
      rows: Object.fromEntries(TABLES.map(table => [table, tables[table].length]))
    }, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`PostgreSQL backup failed: ${error.message}`);
  process.exitCode = 1;
});
