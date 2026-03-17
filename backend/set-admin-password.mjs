#!/usr/bin/env node
/**
 * Set/update the admin password for admin@meetchamp.local
 *
 * Add to backend/.env:
 *   SUPABASE_URL=https://zbkpsxzbyylbwvnsbcgq.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=<from Supabase Dashboard > Settings > API>
 *   NEW_PASSWORD=Admin123!   (optional; default)
 *
 * Run: node set-admin-password.mjs
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NEW_PASSWORD = process.env.NEW_PASSWORD || 'Admin123!';

if (!URL) {
  console.error('Missing SUPABASE_URL or VITE_SUPABASE_URL');
  process.exit(1);
}
if (!SERVICE_KEY) {
  console.error('Missing SUPABASE_SERVICE_ROLE_KEY (get from Supabase Dashboard > Settings > API)');
  process.exit(1);
}
if (NEW_PASSWORD.length < 6) {
  console.error('Password must be at least 6 characters');
  process.exit(1);
}

const supabase = createClient(URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const adminEmail = 'admin@meetchamp.local';

  const { data: users, error: listErr } = await supabase.auth.admin.listUsers();
  if (listErr) {
    console.error('List users failed:', listErr.message);
    process.exit(1);
  }

  const admin = users.users.find((u) => u.email === adminEmail);
  if (!admin) {
    console.error(`Admin user "${adminEmail}" not found`);
    process.exit(1);
  }

  const { error: updateErr } = await supabase.auth.admin.updateUserById(admin.id, {
    password: NEW_PASSWORD,
  });

  if (updateErr) {
    console.error('Update password failed:', updateErr.message);
    process.exit(1);
  }

  console.log(`Password updated for ${adminEmail}`);
  console.log('You can now log in with the new password.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
