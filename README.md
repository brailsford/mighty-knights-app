# Mighty Knights App

A simple Next.js + Supabase app for logging U9 match minutes with rolling subs and season stats.

## Getting Started
1. Copy `.env.local.example` → `.env.local` and set your Supabase URL + anon key.
2. Run the SQL in `supabase/migrations/001_init.sql` in Supabase SQL editor (EU region recommended).
3. `npm install && npm run dev` → open http://localhost:3000/match

## Deploy
- Import repo to Vercel (Hobby plan is fine), add the two env vars, deploy.
- Add your custom domain in Vercel → Settings → Domains.

## Next steps
- Wire the Match Console to Supabase (events + intervals) and Supabase Realtime.
- Add Join/Viewer/Coach roles and a 6-digit match code.
- Add Season page that aggregates minutes/tries/tackles by player.
