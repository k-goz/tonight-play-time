const path = require('node:path');

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error('SQLite database path is required');

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.POSTGRES_PRISMA_URL;
process.env.DATABASE_PATH = path.resolve(sourcePath);

const { db, databaseReady } = require('../backend/server');

databaseReady
  .then(() => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())))
  .catch(error => {
    console.error(`SQLite upgrade failed: ${error.message}`);
    process.exitCode = 1;
  });
