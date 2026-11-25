# Advanced Combat

Turn-based tactics game (browser). Static site + one Vercel function, backed by Supabase for accounts, game records, leaderboard and feedback.

- `public/` — the game (`index.html`), online layer (`online.js`), `api/config.js` (serves public Supabase settings from env vars)
- `supabase/schema.sql` — tables, row-level security, leaderboard view. Run once in the Supabase SQL editor.

Vercel env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`. Root directory: `public`.
