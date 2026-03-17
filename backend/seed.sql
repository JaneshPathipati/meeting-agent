-- file: backend/seed.sql
-- MeetChamp - Seed Data (for testing)
-- Run this AFTER all other SQL files, and AFTER creating a Supabase Auth admin user

-- Step 1: Create an organization
-- Replace with your actual org name
INSERT INTO organizations (id, name, azure_tenant_id, azure_client_id)
VALUES (
  'a0000000-0000-0000-0000-000000000001',
  'MeetChamp',
  '9d94cb2f-05ce-4ac3-96a0-8a8a97437d2a',
  '41bb61d6-c277-4a44-9d0b-6634f4813f97'
);

-- Step 2: Create admin profile
-- Replace auth_id with the UUID from Supabase Auth after creating the admin user
-- Replace email and name with actual admin details
INSERT INTO profiles (id, auth_id, org_id, email, full_name, role)
VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'f86dea83-de7f-4bfc-8692-41acca1ca1a2',
  'a0000000-0000-0000-0000-000000000001',
  'ritvik.vasundh@utilitarianlabs.com',
  'Ritvik Vasundh',
  'admin'
);

-- Step 3: Create a sample monitored employee profile
-- No auth_id needed - employees don't have Supabase Auth accounts
INSERT INTO profiles (id, org_id, email, full_name, department, microsoft_email, role)
VALUES (
  'b0000000-0000-0000-0000-000000000002',
  'a0000000-0000-0000-0000-000000000001',
  'employee@meetchamp.com',
  'Sample Employee',
  'Engineering',
  'employee@meetchamp.com',
  'user'
);
