# Scriptor

A production-grade meeting transcription and analysis system.

## Architecture

| Component | Description |
|---|---|
| **client-agent/** | Electron desktop app (Windows) — silent meeting detection, audio capture, local transcription, upload |
| **supabase/** | Consolidated database schema reference (PostgreSQL, RLS, functions, triggers, cron) |
| **frontend/** | React admin-only dashboard (Vite + Tailwind + shadcn/ui) |
| **docs/** | Setup guides, architecture docs, admin guide |

## Quick Start

1. Set up Supabase project — see `supabase/schema-complete.sql` for full schema reference
2. Configure `.env` files in `client-agent/` and `frontend/`
3. Install dependencies: `npm install` in both `client-agent/` and `frontend/`
4. See `docs/SETUP.md` for detailed instructions

## Tech Stack

- **Agent:** Electron 28+, sherpa-onnx-node (Parakeet TDT 0.6B), MSAL, MS Graph API
- **Backend:** Supabase (PostgreSQL, Auth, Storage, pg_net, pg_cron, Vault)
- **Frontend:** React 18+, Vite 5+, Tailwind CSS 3+, shadcn/ui, Recharts
- **AI:** OpenAI gpt-4o (category detection, summaries, tone analysis)

## License

Proprietary — All rights reserved.
