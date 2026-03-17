# MeetChamp - Setup Guide

## Prerequisites

- Node.js v18+ and npm
- Python 3.10+ (for native module builds)
- Git
- ffmpeg (bundled with agent, or system-installed for dev)
- SoX (for mic recording via node-record-lpcm16)
- Visual Studio C++ Build Tools 2022 (for native Node modules)
- A Supabase project (free or Pro tier)
- An Azure AD App Registration (free tier)
- An OpenAI API key (pay-as-you-go)

## Step 1: Supabase Setup

1. Create a new project at [supabase.com](https://supabase.com)
2. Note your **Project URL**, **anon key**, and **service role key** from Settings > API
3. Enable extensions in Database > Extensions:
   - `pg_net`
   - `pg_cron`
   - `vault` (pgsodium)
4. Run SQL files in order in the SQL Editor:
   - `backend/schema.sql`
   - `backend/rls-policies.sql`
   - `backend/functions.sql`
   - `backend/triggers.sql`
   - `backend/cron-jobs.sql`
5. Create an admin user in Authentication > Users
6. Store OpenAI key: `SELECT vault.create_secret('sk-proj-XXXX', 'openai_api_key');`
7. Customize and run `backend/seed.sql`

## Step 2: Azure AD App Registration

See `docs/AZURE_AD_SETUP.md` for detailed instructions.

## Step 3: Client Agent Setup

1. `cd client-agent && npm install`
2. Copy `.env.example` to `.env`, fill in credentials
3. Download Parakeet ONNX model files to `models/`
4. Place `ffmpeg.exe` and `audiocapturer.exe` in `bin/`
5. `npm run rebuild` (rebuild native modules for Electron)
6. `npm run dev` to test

## Step 4: Frontend Dashboard Setup

1. `cd frontend && npm install`
2. Copy `.env.example` to `.env`, fill in Supabase URL and anon key
3. `npm run dev` to start dev server
4. Deploy to Vercel for production

## Step 5: Build Installer

1. `cd client-agent && npm run build`
2. Installer output: `release/MeetChamp Setup.exe`
