import { createRequire } from 'module';
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

  // Check tables
  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log('=== Tables ===');
  tables.rows.forEach(r => console.log('  ' + r.table_name));

  // Check extensions
  const exts = await client.query(
    "SELECT extname FROM pg_extension WHERE extname IN ('pg_net','pg_cron','pgsodium','supabase_vault') ORDER BY extname"
  );
  console.log('\n=== Extensions ===');
  exts.rows.forEach(r => console.log('  ' + r.extname));

  // Check RLS enabled
  const rls = await client.query(
    "SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  console.log('\n=== RLS Status ===');
  rls.rows.forEach(r => console.log('  ' + r.tablename + ': ' + (r.rowsecurity ? 'ON' : 'OFF')));

  // Check seed data
  const orgs = await client.query('SELECT id, name FROM organizations');
  console.log('\n=== Organizations ===');
  orgs.rows.forEach(r => console.log('  ' + r.name + ' (' + r.id + ')'));

  const profiles = await client.query('SELECT id, email, role FROM profiles');
  console.log('\n=== Profiles ===');
  profiles.rows.forEach(r => console.log('  ' + r.email + ' [' + r.role + '] (' + r.id + ')'));

  // Check cron jobs
  try {
    const crons = await client.query('SELECT jobname, schedule FROM cron.job');
    console.log('\n=== Cron Jobs ===');
    crons.rows.forEach(r => console.log('  ' + r.jobname + ': ' + r.schedule));
  } catch (e) {
    console.log('\n=== Cron Jobs === (could not query: ' + e.message + ')');
  }

  await client.end();
}

main();
