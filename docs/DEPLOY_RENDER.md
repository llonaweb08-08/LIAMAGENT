# Deploy Liam on Render free + Supabase

This runbook matches the checked-in `render.yaml`, `Dockerfile`, and
`supabase_sync.js`. It assumes one Render web service, one private Supabase
storage bucket, and one UptimeRobot monitor.

## What persists, and what does not

| Item | Lives on Render | Persisted to Supabase |
| --- | --- | --- |
| WhatsApp login (`liam_session/`) | `/data/liam_session` | yes, cache-excluded archive |
| Memory (`liam_memory.db`) | `/data/liam_memory.db` | yes, `VACUUM INTO` snapshot |
| Tool token, pair token | `/data/` | no (set `LIAM_PAIR_TOKEN` in Render) |
| `dm_open`, known members | `/data/` | no |
| Group permissions, pending approvals | memory | no |

Render free has an ephemeral filesystem, 0.1 CPU, 512 MB RAM, and spins down
after 15 minutes without HTTP traffic. The Supabase archive is what makes a
restart survivable; UptimeRobot mostly prevents the spin-down in the first
place.

## 1. Supabase

1. Create a free project at <https://supabase.com>.
2. Open **Storage** and create a private bucket named `liam-session`.
   The bridge also tries to create it on first upload; creating it yourself
   avoids any key-permission surprises.
3. Open **Project Settings -> API Keys** and copy:
   - the Project URL (`https://<project>.supabase.co`), and
   - the **secret** key (`sb_secret_...`). Do not use the publishable key.
4. Keep the bucket private. It contains the WhatsApp login.

Free plan limits are sufficient for a cache-excluded profile (about 20 MB) and
a small SQLite database. Watch the storage and egress quotas if the profile
grows.

## 2. Render

1. Push this repository to GitHub.
2. In Render, choose **New -> Blueprint** and select the repository. Render
   reads `render.yaml`.
3. Fill in every `sync: false` secret in the dashboard:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
   - `MOON_KEYS`, `UNO_KEYS`, `AGNES_KEY`, `HCN_KEY`
   - optional: `GOOGLE_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`,
     `SERPER_API_KEY`, `INSTABOX_API_KEY`, `INSTABOX_MACHINE_ID`
4. Deploy. The first Docker build downloads Node, Python, Puppeteer's Chromium,
   and Playwright's Chromium; expect several minutes.
5. Render keeps `LIAM_PAIR_TOKEN` stable because the blueprint uses
   `generateValue: true`. If you created the service manually, set it yourself
   to a long random string.

The service listens on Render's `PORT` (the image default is 5678) and binds
`0.0.0.0`. Render health-checks `/health`, which stays 200 while WhatsApp is
still restoring or waiting for a QR code. That is intentional: the pairing page
must remain reachable during a cold boot.

## 3. Seed an existing local profile (recommended)

If Liam is already linked on your PC, upload that profile before pairing again:

```powershell
$env:LIAM_DATA_DIR="$env:LOCALAPPDATA\LiamWhatsApp"
$env:SUPABASE_URL="https://<project>.supabase.co"
$env:SUPABASE_SECRET_KEY="sb_secret_..."
npm run seed:supabase
```

The script archives `liam_session/` without Chromium caches, snapshots the
memory DB safely, and uploads both objects. It prints a JSON result and exits
non-zero on failure. The local profile is not modified.

Then restart (or redeploy) the Render service. The logs should say
`session restored from Supabase`. If they say `no remote session archive`,
the seed upload did not reach the configured bucket.

## 4. Pair on Render

Open the deploy logs and find:

```
🔗 Pairing page: https://<service>.onrender.com/pair?token=<LIAM_PAIR_TOKEN>
```

Open that URL and either:

- enter the bot's phone number (default `447881161023`) to get an
  **8-character pairing code**, then use WhatsApp on that phone ->
  **Linked devices -> Link with phone number**, or
- open `/qr?token=<LIAM_PAIR_TOKEN>` and scan the QR.

The code/QR expires quickly. Reload the page for a new one. Once linked, the
logs show `LIAM IS LIVE`, the bridge backs up the session after three seconds,
and `/ready` starts returning 200.

If the session is restored successfully, pairing is not needed at all.

## 5. Verify

```powershell
node scripts/verify_deployment.js https://<service>.onrender.com
```

Expected result:

- `/health` -> 200 `{"ok":true,"status":"alive"}`
- `/status` -> `whatsappReady: true`, `agentRunning: true`
- `/ready` -> 200

During pairing, `/ready` is 503 and `/status` shows `needsQr: true`. Use
`--allow-not-ready` for a deploy-only check.

Send a WhatsApp message from an owner phone. The logs should show
`📩 <phone>: ...` followed by Liam's reply.

## 6. UptimeRobot

Create an HTTP(s) monitor:

- URL: `https://<service>.onrender.com/health`
- Interval: 5 minutes

That request keeps the free instance awake. Optionally add a second monitor on
`/ready` if you want an alert when Liam is not linked. `/ready` returns 503
until WhatsApp is connected, so do not use it as the only keep-alive monitor
unless you are comfortable with "down" alerts during pairing and restarts.

## 7. Operations

### Logs to look for

| Log line | Meaning |
| --- | --- |
| `session restored from Supabase (N entries)` | profile restored |
| `db restored from Supabase` | memory restored |
| `no remote session archive` | bucket empty or wrong credentials |
| `QR READY` / `Pairing page` | waiting for a link |
| `LIAM IS LIVE` | WhatsApp connected, agent started |
| `session backed up to Supabase` | persistence working |
| `warn: session backup failed: status 401` | wrong/expired Supabase secret key |
| `warn: session backup failed: status 413` | archive over the bucket limit |

### Recovering a bad deploy

1. Open `/status` and `/ready`.
2. If `/health` is down, read the Render deploy logs. A common cause is a
   failed `npm ci` while downloading Chromium; redeploy usually fixes it.
3. If `/health` is up but `/ready` is 503 with `needsQr`, pair again.
4. If the profile restores but WhatsApp logs out immediately, the archive is
   stale or was created with a different Chrome profile. Re-run
   `npm run seed:supabase` from the working local install, or pair again on
   Render.
5. If memory is empty but the session works, the DB object is missing or was
   rejected as non-SQLite. The bridge logs the reason; a fresh DB is created so
   Liam keeps working.

### Rotating the Supabase secret

Update `SUPABASE_SECRET_KEY` in Render, then redeploy. Existing archives remain
in the bucket. The bridge does not store the key anywhere on disk.

### Changing the bot phone

`LIAM_BOT_PHONE` only affects the prefilled pairing page. It does not change
the WhatsApp account; pair the phone number that actually owns the account.

### InstaBox

Set `INSTABOX_API_KEY` and `INSTABOX_MACHINE_ID`. `vps_exec` calls
`POST https://api.instabox.sh/v1/machines/<id>/exec`, which auto-resumes an
idle-paused free machine. There is no inbound SSH. Non-owners must get a
one-time owner approval for each command.

## 8. Local Docker check

Docker is not required in production, but building the same image locally
catches dependency mistakes before Render does:

```powershell
docker build -t liam:local .
docker run --rm -p 5678:5678 --env-file .env -v liam-data:/data liam:local
```

Then open <http://127.0.0.1:5678/health>.

## 9. Free-tier limits

- **Instance hours:** 750 per month. One always-awake service uses about 720.
- **RAM:** 512 MB. WhatsApp Chromium plus a Playwright browser can exceed it;
  run browser tasks one at a time and avoid full-page screenshots.
- **CPU:** 0.1. Model calls are network-bound, but heavy scraping will be slow.
- **Disk:** ephemeral. Supabase restore is mandatory for continuity.
- **Spin-down:** 15 minutes without traffic. UptimeRobot keeps it warm.
- **SMTP:** blocked. `email_read` (IMAP 993) works; sending mail does not.
