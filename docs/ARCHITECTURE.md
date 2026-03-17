# MeetChamp - Architecture

## System Overview

```
Employee Laptop                    Cloud (Supabase)                Admin Browser
┌─────────────────┐    HTTPS     ┌──────────────────┐    HTTPS    ┌──────────────┐
│  Silent Agent   │ ──────────> │   PostgreSQL     │ <────────── │  React       │
│  (Electron)     │             │   + pg_net       │             │  Dashboard   │
│                 │             │   + pg_cron      │             │  (Vercel)    │
│  - Detect mtg   │             │   + Vault        │             │              │
│  - Record audio │             │   + Auth         │             │  - View all  │
│  - Transcribe   │             │   + Realtime     │             │  - Summaries │
│  - Upload       │             │                  │             │  - Alerts    │
└─────────────────┘             │  OpenAI API ←──┘ │             │  - Analytics │
                                └──────────────────┘             └──────────────┘
```

## Data Flow

1. **Agent detects meeting** via process + window title heuristics (5s polling)
2. **30s debounce** confirms meeting is real (not a false positive)
3. **Audio recording** starts: mic (SoX) + system audio (audiocapturer)
4. **Meeting ends** detected when signals lost for 60s
5. **Audio mixing** via ffmpeg → single 16kHz mono WAV
6. **Local transcription** via Parakeet TDT 0.6B (sherpa-onnx-node)
7. **Upload** meeting + transcript to Supabase (service role key, bypasses RLS)
8. **Teams transcript check** (if Teams meeting): 3 attempts at 5/10/15 min
9. **DB trigger fires** → calls OpenAI for category detection via pg_net
10. **pg_cron polls** every minute for completed OpenAI responses
11. **Category → Summary + Tone** analysis fired as follow-up OpenAI calls
12. **Results stored** in summaries + tone_alerts tables
13. **Admin dashboard** shows results via Supabase Realtime

## Security Model

- **Agent → Supabase**: Service role key (encrypted in electron-store)
- **Admin → Supabase**: Supabase Auth (email/password), JWT, RLS enforced
- **Agent → Microsoft**: MSAL tokens (encrypted in electron-store)
- **Supabase → OpenAI**: API key in Vault, called via pg_net
- **All RLS policies**: Scoped by org_id, admin-only reads

## Offline Resilience

- Failed uploads queued in local SQLite (better-sqlite3)
- Retry on startup + every 5 minutes
- Exponential backoff: 1m, 5m, 15m, 1h, 4h
- Max 5 retries before permanent failure
