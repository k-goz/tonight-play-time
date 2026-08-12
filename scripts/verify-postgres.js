const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
  process.exit(1);
}

const url = new URL(connectionString);
url.searchParams.delete('sslmode');
const pool = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 1 });

async function main() {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15s'");
    const version = await client.query('SELECT MAX(version) AS version FROM schema_migrations');
    const missingForeignKeyIndexes = await client.query(`
      SELECT conrelid::regclass::text AS table_name, attribute.attname AS column_name
      FROM pg_constraint constraint_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = ANY(constraint_row.conkey)
      WHERE constraint_row.contype = 'f'
        AND constraint_row.connamespace = 'public'::regnamespace
        AND NOT EXISTS (
          SELECT 1 FROM pg_index index_row
          WHERE index_row.indrelid = constraint_row.conrelid
            AND attribute.attnum = ANY(index_row.indkey)
        )
      ORDER BY 1, 2
    `);
    const counts = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM child_profiles) AS children,
        (SELECT COUNT(*) FROM homework_sessions) AS sessions,
        (SELECT COUNT(*) FROM sync_conflicts WHERE status = 'pending') AS pending_conflicts
    `);
    if (Number(version.rows[0]?.version) !== 6) throw new Error('PostgreSQL schema is not V6');
    if (missingForeignKeyIndexes.rowCount > 0) {
      throw new Error(`Missing foreign-key indexes: ${JSON.stringify(missingForeignKeyIndexes.rows)}`);
    }
    console.log(JSON.stringify({
      status: 'ok', schema_version: 6, tls: true,
      foreign_key_indexes: 'ok', counts: counts.rows[0]
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`PostgreSQL verification failed: ${error.message}`);
  process.exitCode = 1;
});
