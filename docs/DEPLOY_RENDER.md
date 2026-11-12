# Deploy Liam on Render free + Supabase

This runbook matches the checked-in `render.yaml`, `Dockerfile`, and
`supabase_sync.js`. It assumes one Render web service, one private Supabase
storage bucket, and one UptimeRobot monitor.

## What persists, and what does not

| Item | Lives on Render | Persisted to Supabase |
| --- | --- | --- |
| WhatsApp login (`liam_session/`) | `/data/liam_session` | yes, small Baileys archive |
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

Free plan limits are sufficient: a Baileys session archive is well under 1 MB,
and the SQLite database is small.

## 2. Render

1. Push this repository to GitHub.
2. In Render, choose **New -> Blueprint** and select the repository. Render
   reads `render.yaml`.
3. Fill in every `sync: false` secret in the dashboard:
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
   - `MOON_KEYS`, `UNO_KEYS`, `AGNES_KEY`, `HCN_KEY`
   - optional: `GOOGLE_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`,
     `SERPER_API_KEY`, `INSTABOX_API_KEY`, `INSTABOX_MACHINE_ID`
4. Deploy. The first Docker build downloads Node, Python, and Playwright's
   Chromium (for screenshots); expect several minutes. There is no Puppeteer or
   WhatsApp browser download.
5. Render keeps `LIAM_PAIR_TOKEN` stable because the blueprint uses
   `generateValue: true`. If you created the service manually, set it yourself
   to a long random string.

The service listens on Render's `PORT` (the image default is 5678) and binds
`0.0.0.0`. Render health-checks `/health`, which stays 200 while WhatsApp is
still restoring or waiting for a pairing code. That is intentional: the pairing
page must remain reachable during a cold boot.

## 3. Optional: reuse an existing Baileys login

Only do this if you already linked Liam with **this Baileys version** on another
machine. A `whatsapp-web.js`/Chromium profile cannot be imported; skip to
section 4 and pair on Render.

```powershell
$env:LIAM_DATA_DIR="C:\path\to\baileys-data"
$env:SUPABASE_URL="https://<project>.supabase.co"
$env:SUPABASE_SECRET_KEY="sb_secret_..."
npm run seed:supabase
```

The script validates the archive before uploading, snapshots the memory DB
safely, and exits non-zero unless the WhatsApp login itself uploaded. The local
profile is not modified.

Then restart (or redeploy) the Render service. The logs should say
`session restored from Supabase`. If they say `no remote session archive`, the
upload did not reach the configured bucket.

## 4. Pair on Render

Open the deploy logs and find:

```
🔗 Pairing page: https://<service>.onrender.com/pair?token=<LIAM_PAIR_TOKEN>
```

Pairing uses an **8-character phone code**. There is no QR scan.

1. First remove stale devices: on the bot phone open WhatsApp **Business** ->
   **Settings** -> **Linked devices** and delete every old **Liam** entry.
   WhatsApp allows at most 4 devices, and every failed attempt leaves one
   behind.
2. On the phone open **Linked devices** -> **Link a device** ->
   **Link with phone number instead**. Leave that screen waiting.
3. On the Render pairing page, confirm the number (default `447881161023`) and
   press **Get pairing code** once.
4. Type the code on the phone immediately. Do not reload the page or press the
   button again while you type: that cancels the handshake and leaves a zombie
   device.

Opening or reloading `/pair` never creates a code; only the button does, so a
refresh cannot burn one of WhatsApp's few allowed attempts. A code is reused for
60 seconds and a new request is refused for 120 seconds
(`LIAM_PAIRING_COOLDOWN_MS`). If WhatsApp answers `429 rate-overlimit`, wait
10-15 minutes before trying again.

A successful code entry normally closes the socket with `restartRequired`
(515). The bridge reconnects immediately with the same credentials; that is not
an error. Once linked, the logs show `LIAM IS LIVE`, the bridge backs up the
session after three seconds, and `/ready` starts returning 200.

A session is only kept when `liam_session/session/creds.json` and
`wa_linked.json` both exist. On boot, a profile without them is deleted so a
half-finished link or a corrupt restore can never poison the next attempt.

If a link attempt gets stuck, two token-protected helpers exist:

- `/cancelpair?token=<LIAM_PAIR_TOKEN>` — discard the half-finished code
  attempt, wipe the unlinked profile, and wait for a fresh button press.
- `/reset?token=<LIAM_PAIR_TOKEN>` — close the socket, delete the local login,
  and start a clean connection without restarting Render.

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
| `session restored from Supabase (N entries)` | session restored |
| `db restored from Supabase` | memory restored |
| `no remote session archive` | bucket empty or wrong credentials |
| `READY TO PAIR` / `Pairing page` | waiting for a link (the log repeats at most every 5 minutes) |
| `LIAM IS LIVE` | WhatsApp connected, agent started |
| `WhatsApp connection closed (515)` | expected `restartRequired` after entering the code; the bridge reconnects |
| `session backed up to Supabase` | persistence working |
| `warn: session backup failed: status 401` | wrong/expired Supabase secret key |
| `warn: session backup failed: status 413` | archive over the bucket limit |

### Recovering a bad deploy

1. Open `/status` and `/ready`.
2. If `/health` is down, read the Render deploy logs. A common cause is a
   failed `npm ci`; redeploy usually fixes it.
3. If `/health` is up but `/ready` is 503 with `needsQr`, pair again (section 4).
   If WhatsApp answers `429`, wait 10-15 minutes and remove stale linked devices
   first.
4. If the session restores but WhatsApp logs out immediately, the archive is
   stale or was made by a different WhatsApp version. Pair again on Render.
5. If memory is empty but the session works, the DB object is missing or was
   rejected as non-SQLite. The bridge logs the reason; a fresh DB is created so
   Liam keeps working.
6. If a link attempt fails with `couldn't link device`, remove every old **Liam**
   entry under **Linked devices** on the phone. Failed attempts leave zombie
   entries that block a new link.

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
- **RAM:** 512 MB. The Baileys bridge is small, but a Playwright screenshot or
  browser task creates its own Chromium and can exceed the limit; run browser
  tasks one at a time and avoid full-page screenshots.
- **CPU:** 0.1. Model calls are network-bound, but heavy scraping will be slow.
- **Disk:** ephemeral. Supabase restore is mandatory for continuity.
- **Spin-down:** 15 minutes without traffic. UptimeRobot keeps it warm.
- **SMTP:** blocked. `email_read` (IMAP 993) works; sending mail does not.
