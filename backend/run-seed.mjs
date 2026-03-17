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

  await client.connect();
  console.log('Connected!');

  const sql = readFileSync(resolve(__dirname, 'seed.sql'), 'utf-8');
  console.log('Running seed.sql...');
  try {
    await client.query(sql);
    console.log('OK: seed.sql');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  await client.end();
}

main();
