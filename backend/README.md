# MeetChamp - Backend (Supabase)

## SQL Files - Execution Order

Run these files in the Supabase SQL Editor in this exact order:

1. **schema.sql** - Tables, indexes, updated_at triggers
2. **rls-policies.sql** - Row Level Security policies (admin-only reads)
3. **functions.sql** - OpenAI integration via pg_net
4. **triggers.sql** - Auto-process transcripts on insert/update
5. **cron-jobs.sql** - Polling pipeline + data retention cleanup
6. **seed.sql** - Initial org + admin profile (customize before running)

## Prerequisites

- Supabase project with these extensions enabled:
  - `uuid-ossp` (usually enabled by default)
  - `pg_net` (enable in Supabase Dashboard > Database > Extensions)
  - `pg_cron` (enable in Supabase Dashboard > Database > Extensions)
  - `vault` (enable for OpenAI key storage)

## After Schema Setup

1. Create an admin user in Supabase Auth (Dashboard > Authentication > Users)
2. Store the OpenAI API key: `SELECT vault.create_secret('sk-proj-XXXX', 'openai_api_key');`
3. Update `seed.sql` with actual values and run it
