# Plan: Deploy Liam on Render (free) with Supabase persistence

## Goal
Run Liam 24/7 on Render's free tier, persisting WhatsApp session files and memory across restarts via Supabase (storage + Postgres), and use Instabox for root/pentesting tasks.

## Constraints
- Render free: spins down after 15 min idle, ephemeral filesystem, 512 MB RAM, 750 instance hours/month, no outbound SMTP.
- Supabase new key model: publishable (`sb_publishable_...`) + secret (`sb_secret_...`). No anon/service_role.
- UptimeRobot pings `/health` every 5 min to prevent spin-down.

## User-facing steps (Supabase)
1. Dashboard → top-right **Connect** button → choose **Session pooler** (or Direct) → copy connection string → replace `[YOUR-PASSWORD]` with the DB password set at project creation. If forgotten: Settings → Database → Reset database password.
2. Dashboard → **Storage** → **New bucket** → name `liam-session` → private.
3. Dashboard → **Settings → API Keys** → copy Project URL, publishable key, secret key.

## Code changes required (implementation agent)
1. **Dockerfile**: Node 20 + Python 3.12 + Playwright Chromium + system deps; `npm ci`, `pip install -r requirements.txt`, `playwright install chromium`.
2. **Health endpoint**: add `GET /health` to `whatsapp_bridge.js` returning 200 JSON (no auth, or token-gated).
3. **Session sync**: on startup, download `liam_session/` from Supabase Storage bucket `liam-session`; on change (or periodic), upload. Use `sb_secret_` key server-side. Store in env `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_STORAGE_BUCKET`.
4. **Memory DB migration**: replace SQLite `_connect()` with Postgres (psycopg) using `DATABASE_URL`. Keep schema. Migrate `_init_db`, `_facts`, `remember`, `recall`, `recall_all`, `clear_memory`.
5. **render.yaml**: define web service, env vars, health check path `/health`.
6. **UptimeRobot**: HTTP monitor on Render URL `/health` every 5 min (user sets up in UptimeRobot dashboard).

## Instabox integration
- Add `instabox` tool to agent (create machine, exec, snapshot) using `INSTABOX_API_KEY`. Defer until user provides key.

## Validation
- `docker build` succeeds locally.
- `docker run` starts bridge + agent; WhatsApp QR appears; pairing succeeds.
- Restart container → session restored from Supabase (no QR).
- Memory facts persist across restarts.
- `/health` returns 200.
- UptimeRobot keeps service awake.

## Risks / notes
- Render free can restart at any time → session restore must be robust and idempotent.
- 512 MB RAM → keep browser tasks sequential.
- No outbound SMTP → `email_read` (IMAP 993) works; sending email does not.
- Render free 750 instance hours/month ≈ 24/7 for one service.

## Open questions for user
- Provide Supabase DB connection string (from Connect dialog) and confirm bucket name `liam-session`.
- Confirm Render free (with all caveats) vs paid ($7/mo + disk).
- Provide Instabox API key when ready.

## Out of scope
- DM locking (pending user go-ahead).
- Pentesting tool installation (Instabox handles separately).