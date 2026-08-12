const { Pool } = require('pg');

const TABLES = [
  'users', 'child_profiles', 'homework_sessions', 'auth_tokens', 'parent_grants',
  'family_preferences', 'weekly_rewards', 'streak_protections', 'reminder_events',
  'sync_conflicts', 'audit_logs', 'product_events'
];
const IDENTITY_TABLES = TABLES.filter(table => !['auth_tokens', 'parent_grants', 'family_preferences'].includes(table));

function connectionString() {
  const value = process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!value) throw new Error('DATABASE_URL_UNPOOLED or DATABASE_URL is required');
  return value;
}

function createPool() {
  const url = new URL(connectionString());
  url.searchParams.delete('sslmode');
  return new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 1 });
}

async function resetIdentitySequences(client) {
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
}

module.exports = { TABLES, IDENTITY_TABLES, createPool, resetIdentitySequences };
