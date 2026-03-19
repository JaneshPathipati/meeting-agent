# Scriptor - Admin Dashboard

React admin-only dashboard for viewing meetings, transcripts, summaries, and tone alerts.

## Setup

1. Copy `.env.example` to `.env` and fill in Supabase credentials
2. Run `npm install`
3. Run `npm run dev` for local development
4. Run `npm run build` for production build

## Deploy to Vercel

1. Push to GitHub
2. Import project in Vercel
3. Set environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
4. Deploy

## Tech Stack

- React 18 + Vite 5
- Tailwind CSS 3
- Lucide React icons
- Recharts for analytics
- Supabase JS client
- React Router v6
