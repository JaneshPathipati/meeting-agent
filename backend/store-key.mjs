import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN_STRING = process.env.SUPABASE_DB_URL;

const OPENAI_KEY = process.env.OPENAI_API_KEY;

async function main() {
  if (!CONN_STRING) {
    console.error('Missing env var: SUPABASE_DB_URL');
    process.exit(1);
  }
  if (!OPENAI_KEY) {
    console.error('Missing env var: OPENAI_API_KEY');
    process.exit(1);
  }

  const client = new Client({
    connectionString: CONN_STRING,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });

  await client.connect();
  console.log('Connected!');

  try {
    await client.query("SELECT vault.create_secret($1, 'openai_api_key')", [OPENAI_KEY]);
    console.log('OK: OpenAI key stored in Vault as "openai_api_key"');
  } catch (err) {
    console.error('FAIL:', err.message);
  }

  // Verify it was stored
  try {
    const res = await client.query("SELECT name FROM vault.secrets WHERE name = 'openai_api_key'");
    if (res.rows.length > 0) {
      console.log('Verified: secret exists in vault');
    } else {
      console.log('Warning: secret not found after insert');
    }
  } catch (err) {
    console.log('Could not verify (expected on pooler): ' + err.message);
  }

  await client.end();
}

main();
