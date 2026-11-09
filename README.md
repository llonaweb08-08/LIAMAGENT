# Liam - WhatsApp AI Agent

Liam is a self-hosted WhatsApp agent. A Node bridge keeps a `whatsapp-web.js`
session alive and talks to a Python agent over newline-delimited JSON on stdio.
The Python side owns model routing, memory, and tools.

```
WhatsApp <-> whatsapp_bridge.js <-> JSON lines over stdio <-> agent.py
                                      |
                                      +-> authenticated 127.0.0.1 tool endpoint
                                          (send, image, voice, leave, stop, ...)
```

The intended deployment is **Render free + Supabase Storage + UptimeRobot**.
Render's filesystem is ephemeral, so the WhatsApp profile and SQLite memory are
archived to a private Supabase bucket and restored on boot. See
[docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md) for the full runbook.

## Requirements

- Node.js **20+** (24.x tested)
- Python **3.10+** (3.12 tested)
- npm 10+
- Windows is the primary local target (the launch scripts are `.bat`), but the
  code is cross-platform and runs in the provided Docker image.

## Install

```powershell
npm ci
python -m pip install -r requirements.txt
python -m playwright install chromium   # screenshots and browser tasks
```

`npm ci` runs Puppeteer's install script and downloads Chromium for WhatsApp
Web. That download is large and is required for the bridge to start.

## Configuration

No API keys are stored in tracked source files. Set environment variables, or
create a local `liam_secrets.py` (git-ignored) that defines the same names.
Environment variables take precedence. Copy `.env.example` for the full list.

```python
MOON_KEYS = ["...", "..."]
UNO_KEYS = ["...", "..."]
AGNES_KEY = "..."
HCN_KEY = "..."
GOOGLE_API_KEY = ""   # optional: image generation and voice notes
TAVILY_API_KEY = ""   # optional: search providers
BRAVE_API_KEY = ""
SERPER_API_KEY = ""
```

`MOON_KEYS` and `UNO_KEYS` accept a list or a comma-separated string when
supplied through the environment.

The model chain is **MoonMath -> GLM -> Agnes -> HCN**. Only these
tool-capable providers run the tool loop. Unorouter remains available as an
explicit chat-only brain and is never used implicitly. Hugging Face is no
longer used because the public router rejected the configured models.

`liam_config.json` is shared by Python and Node and defines `owners` (phone
numbers in international format, digits only) and `admins` (name, relation,
and the names Liam may use). The bridge refuses to start if no owner is set.

## Run locally

```powershell
.\start_liam.bat
```

or:

```powershell
npm start
```

On first run, scan the WhatsApp QR in the console or open the pairing page
printed in the logs. `npm run doctor` checks the local profile, providers, and
memory database without printing any secret values.

## Pairing

Pairing is available in two forms, both token-protected:

- `/qr?token=...` renders the current QR code.
- `/pair?token=...` generates an **8-character pairing code** for the bot's
  phone number (`LIAM_BOT_PHONE`, default `447881161023`). Open WhatsApp on
  that phone -> Linked devices -> Link with phone number.

`LIAM_PAIR_TOKEN` comes from the environment. If it is not set, a random token
is generated in `LIAM_DATA_DIR/pair_token`; that file is not archived, so set
the variable on Render to keep a stable pairing URL across restarts.
`render.yaml` uses `generateValue: true`, and the URL is printed in the deploy
logs.

## Runtime data

Runtime state lives outside the repository, in
`%LOCALAPPDATA%\LiamWhatsApp` by default. Set `LIAM_DATA_DIR` to override it;
the Docker image uses `/data`.

| File / directory | Purpose |
| --- | --- |
| `liam_session/` | WhatsApp/Chrome login credentials - treat like a password |
| `tool_token` | 32-byte bearer token shared by the bridge and Python |
| `pair_token` | secret for `/qr` and `/pair` when `LIAM_PAIR_TOKEN` is unset |
| `known_members.json`, `dm_open` | DM policy state |
| `stop_flag`, `brain_state` | control state, written atomically |
| `outbox/` | only directory the bridge will send media from |
| `qr.png` | transient pairing QR, deleted after authentication |

The memory database defaults to `liam_memory.db` in the project directory; set
`LIAM_DB` to move it. Legacy `.stop`, `.brain_state`, and session files are
migrated automatically on the next bridge start; old QR images are deleted.
`LIAM_PORT`/`PORT` moves the HTTP endpoint (default `5678`), and Python's client
can follow it with `LIAM_BRIDGE_URL`.

## Persistence

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set:

- On boot the bridge restores the SQLite DB and the WhatsApp profile before
  starting Chromium. Each step has a timeout so a slow Supabase cannot hang
  startup forever.
- The session archive excludes Chromium caches and lock files but keeps
  `IndexedDB` and the service-worker database, which contain the login.
  A verified profile archive is about 20 MB instead of 190 MB.
- The DB backup uses SQLite `VACUUM INTO`, so it is consistent while the agent
  is writing (a raw file copy is not WAL-safe).
- Archives are listed and validated before extraction; absolute paths, `..`,
  links, and entries outside `liam_session/` are rejected. Restore happens in a
  staging directory and is swapped into place atomically.
- A backup runs three seconds after WhatsApp becomes ready, every
  `LIAM_BACKUP_INTERVAL_MS` (10 minutes by default), and on graceful shutdown.

Run `npm run seed:supabase` on a machine that already has a linked profile to
upload the first archive (see the runbook).

## Security model

- The HTTP server is public only for `/health`, `/status`, and the token-gated
  `/qr` and `/pair` pages. Tool actions additionally require a loopback peer, a
  loopback `Host` header, no browser `Origin`, `application/json`, and the
  32-byte bearer token.
- Bodies are capped at 64 KB; outbound media at 25 MB. Outbound sends are
  rate-limited to 20 per minute and restricted to owners/admins (plus
  `LIAM_DM_ALLOWLIST`).
- Media must resolve inside `outbox/`; path traversal and symlink escapes are
  rejected.
- Screenshots accept public `http(s)` URLs only and re-check every redirect and
  subresource. Credentials, localhost, private, link-local, and reserved
  addresses are rejected (SSRF guard).
- Errors returned over the endpoint are generic; secrets and stack traces stay
  in the console.
- Chromium runs as an unprivileged user with `--no-sandbox` inside the
  container. The container itself is the isolation boundary; do not expose the
  tool endpoint or the runtime data directory directly.

### Members, owners, and approvals

- Owners and admins can DM Liam. Other people can DM only after an owner runs
  `.allowdm`; `.disallowdm` closes DMs again. `.allowdm` covers owners, admins,
  and people Liam has already seen in a group.
- In groups, members must tag Liam, reply to one of Liam's messages, or address
  Liam by name. A member then needs a **3-hour permission per group**. The
  permission prompt goes to the group when an owner is present, otherwise to
  every owner by DM.
- Members get chat, memory, web search, and web fetch. Owner-only tools include
  outbound sends, screenshots, file access, `shell_exec`, `browser_task`,
  brain switching, permissions, and progress reports.
- `vps_exec` runs on the InstaBox VM through its REST API, never through
  inbound SSH. Any non-owner request creates a **one-time, 10-minute owner
  approval** that shows the exact tool and arguments. The owner must reply with
  the request id (`yes t123abc`); a bare `yes`/`ok` never approves a shell
  command.
- `shell_exec` (owner-only) runs inside the Render container. It is not
  persistent and is not the pentest machine; use `vps_exec`/InstaBox for that.

## Tests and checks

```powershell
python -m unittest discover -s tests -v
node --test "tests/**/*.test.js"
python -m ruff check .
npm run check
npm audit --omit=dev
npm run doctor
```

The bridge tests run against a temporary copy of `whatsapp_bridge.js` with a
stubbed WhatsApp client, so they never touch a real session or send messages.
The Supabase tests use a local mock storage server.

## Deployment

The short version:

1. Create a Supabase project and a private `liam-session` bucket (the bridge
   creates it automatically if the secret key is allowed to).
2. Apply `render.yaml` on Render and fill in the `sync: false` secrets.
3. Optionally seed an existing local WhatsApp profile with
   `npm run seed:supabase`.
4. Open the `/pair` URL from the Render logs and link the bot phone.
5. Point UptimeRobot at `/health` every 5 minutes to keep the free instance
   awake, and at `/ready` if you want an alert when Liam is not linked.

Full instructions, including the exact environment variables and recovery
steps, are in [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

## Known limitations

- Render free has 0.1 CPU, 512 MB RAM, an ephemeral disk, and spins down after
  15 minutes without HTTP traffic. UptimeRobot prevents most spin-downs, but a
  restart can still happen at any time; Supabase is what makes that survivable.
- Running WhatsApp Chromium and a Playwright screenshot at the same time can
  exceed 512 MB. Keep browser work sequential and avoid large screenshots.
- Group permissions and pending approvals are in memory. After a restart,
  members are asked again and approvals must be re-requested. `dm_open` lives
  on the ephemeral disk unless `LIAM_DM_OPEN` is set.
- `npm audit` still reports advisories in dependencies pinned by
  `whatsapp-web.js` (Puppeteer/Chromium and transitive packages). Forcing the
  suggested downgrade of `whatsapp-web.js` makes the report worse and is not
  applied. Re-check when a new release updates those dependencies.
- WhatsApp automation is outside WhatsApp's Terms of Service. Aggressive
  outbound messaging increases the risk of an account ban; the rate limit and
  allowlist reduce, but do not remove, that risk.
- Image generation and voice notes need `GOOGLE_API_KEY`. Voice output is a
  valid WAV; it is converted to OGG/Opus only when `ffmpeg` is on `PATH`
  (installed in the Docker image).
