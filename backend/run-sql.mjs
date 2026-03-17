// Utility script to run SQL files against Supabase via pg connection
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN_STRING = process.env.SUPABASE_DB_URL;

async function main() {
  if (!CONN_STRING) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }

  const client = new Client({
    connectionString: CONN_STRING,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  console.log('Connecting to Supabase...');
  await client.connect();
  console.log('Connected!');

  // SQL files to run in order
  const sqlFiles = [
    'schema.sql',
    'rls-policies.sql',
    'functions.sql',
    'triggers.sql',
    'cron-jobs.sql',
    'seed.sql',
  ];

  for (const file of sqlFiles) {
    const filePath = resolve(__dirname, file);
    const sql = readFileSync(filePath, 'utf-8');
    console.log('\n========== Running: ' + file + ' ==========');
    try {
      await client.query(sql);
      console.log('OK: ' + file);
    } catch (err) {
      console.error('FAIL: ' + file + ' -> ' + err.message);
    }
  }

  console.log('\n========== All SQL files processed ==========');
  await client.end();
}

main();
