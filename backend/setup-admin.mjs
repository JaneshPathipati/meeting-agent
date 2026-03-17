import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { Client } = require('pg');

const CONN_STRING = process.env.SUPABASE_DB_URL;

const AUTH_ID = 'f86dea83-de7f-4bfc-8692-41acca1ca1a2';
const ADMIN_EMAIL = 'ritvik.vasundh@utilitarianlabs.com';
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

  console.log('Connecting to Supabase...');
  await client.connect();
  console.log('Connected!');

  // Step 1: Link auth_id to admin profile
  console.log('\n--- Linking auth_id to admin profile ---');
  const linkResult = await client.query(
    'UPDATE profiles SET auth_id = $1 WHERE email = $2',
    [AUTH_ID, ADMIN_EMAIL]
  );
  console.log('Rows updated:', linkResult.rowCount);

  // Step 2: Store OpenAI key in vault
  console.log('\n--- Storing OpenAI key in Supabase Vault ---');
  try {
    // Delete old key if exists, then create new one
    await client.query("DELETE FROM vault.secrets WHERE name = 'openai_api_key'");
    console.log('Old key removed (if any)');
    await client.query("SELECT vault.create_secret($1, 'openai_api_key')", [OPENAI_KEY]);
    console.log('OpenAI key stored successfully!');
  } catch (err) {
    console.error('Vault error:', err.message);
  }

  // Step 3: Verify
  console.log('\n--- Verifying setup ---');
  const profile = await client.query(
    'SELECT id, email, role, auth_id FROM profiles WHERE email = $1',
    [ADMIN_EMAIL]
  );
  console.log('Admin profile:', profile.rows[0]);

  const vault = await client.query(
    "SELECT name, length(decrypted_secret) as key_length FROM vault.decrypted_secrets WHERE name = 'openai_api_key'"
  );
  console.log('Vault key:', vault.rows[0]);

  await client.end();
  console.log('\nSetup complete!');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
