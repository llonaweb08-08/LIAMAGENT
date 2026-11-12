# Liam - WhatsApp AI Agent

Liam is a self-hosted WhatsApp agent. A Node bridge keeps a **Baileys**
WhatsApp session alive and talks to a Python agent over newline-delimited JSON
on stdio. The Python side owns model routing, memory, and tools.

```
WhatsApp <-> whatsapp_bridge.js (Baileys) <-> JSON lines over stdio <-> agent.py
                                      |
                                      +-> authenticated 127.0.0.1 tool endpoint
                                          (send, image, voice, leave, stop, ...)
```

Baileys speaks the WhatsApp Web protocol directly, so the bridge needs no
Chromium or Puppeteer. That keeps it inside Render free's 512 MB memory limit.

The intended deployment is **Render free + Supabase Storage + UptimeRobot**.
Render's filesystem is ephemeral, so the WhatsApp login and SQLite memory are
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

`npm ci` installs Baileys (pure JavaScript, no browser download). Playwright's
Chromium is optional and is only needed for screenshots and browser tasks.

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

On first run, open the pairing page printed in the logs and press the button once
to get an 8-character code. There is no QR scan. `npm run doctor` checks the
local login, providers, and memory database without printing any secret values.

## Pairing

Pairing uses an **8-character phone code** only - there is no QR scan:

- Open `/pair?token=...` and press the button once. It returns a code for the
  bot's phone number (`LIAM_BOT_PHONE`, default `447881161023`).
- On the bot phone (WhatsApp **Business**): Settings -> Linked devices ->
  Link a device -> **Link with phone number instead**, then type the code.
- WhatsApp allows at most 4 linked devices; remove old **Liam** entries there
  before a new attempt.
- `/qr?token=...` only explains this; it no longer renders a QR code.

`LIAM_PAIR_TOKEN` comes from the environment. If it is not set, a random token
is generated in `LIAM_DATA_DIR/pair_token`; that file is not archived, so set
the variable on Render to keep a stable pairing URL across restarts.
`render.yaml` uses `generateValue: true`, and the URL is printed in the deploy
logs.

A code request is rate-limited by WhatsApp. The bridge reuses a code for 60
seconds and then enforces a 2-minute cooldown (`LIAM_PAIRING_COOLDOWN_MS`).
`/cancelpair` discards a half-finished attempt; `/reset` starts from a clean
login.

## Runtime data

Runtime state lives outside the repository, in
`%LOCALAPPDATA%\LiamWhatsApp` by default. Set `LIAM_DATA_DIR` to override it;
the Docker image uses `/data`.

| File / directory | Purpose |
| --- | --- |
| `liam_session/` | Baileys WhatsApp login (`session/creds.json`) - treat like a password |
| `tool_token` | 32-byte bearer token shared by the bridge and Python |
| `pair_token` | secret for `/pair` when `LIAM_PAIR_TOKEN` is unset |
| `known_members.json`, `dm_open` | DM policy state |
| `stop_flag`, `brain_state` | control state, written atomically |
| `outbox/` | only directory the bridge will send media from |

The memory database defaults to `liam_memory.db` in the project directory; set
`LIAM_DB` to move it. Legacy `.stop`, `.brain_state`, and session files are
migrated automatically on the next bridge start; old QR images are deleted.
`LIAM_PORT`/`PORT` moves the HTTP endpoint (default `5678`), and Python's client
can follow it with `LIAM_BRIDGE_URL`.

## Persistence

When `SUPABASE_URL` and `SUPABASE_SECRET_KEY` are set:

- On boot the bridge restores the SQLite DB and the WhatsApp login before
  starting the socket. Each step has a timeout so a slow Supabase cannot hang
  startup forever.
- The session archive contains Baileys' `creds.json` and app-state keys. It is
  small (well under 1 MB) because there is no browser profile or cache.
- The DB backup uses SQLite `VACUUM INTO`, so it is consistent while the agent
  is writing (a raw file copy is not WAL-safe).
- Archives are listed and validated before extraction; absolute paths, `..`,
  and entries outside `liam_session/` are rejected. Link entries are restored by
  extracting every normal file and safely skipping the links, so an older
  Linux-made profile still restores.
- New archives are built with links dereferenced and are validated **before**
  upload. A bad archive can never replace the last good cloud copy.
- A backup runs three seconds after WhatsApp becomes ready, every
  `LIAM_BACKUP_INTERVAL_MS` (10 minutes by default), and on graceful shutdown.
  Nothing is uploaded before `ready`, so an unlinked profile cannot overwrite a
  linked session.

Run `npm run seed:supabase` only if you already have a **Baileys**-linked
profile on another machine and want to reuse it. A Chromium/`whatsapp-web.js`
profile cannot be imported; pair on Render instead (see the runbook).

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
- The WhatsApp bridge is pure JavaScript (Baileys); it does not launch a
  browser. Playwright Chromium, when installed for screenshots and browser
  tasks, runs as an unprivileged user with `--no-sandbox` inside the container.
  The container itself is the isolation boundary; do not expose the tool
  endpoint or the runtime data directory directly.

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
stubbed Baileys socket, so they never touch a real session or send messages.
The Supabase tests use a local mock storage server.

## Deployment

The short version:

1. Create a Supabase project and a private `liam-session` bucket (the bridge
   creates it automatically if the secret key is allowed to).
2. Apply `render.yaml` on Render and fill in the `sync: false` secrets.
3. Optionally seed an existing **Baileys** profile with
   `npm run seed:supabase` (a Chromium profile cannot be imported).
4. Open the `/pair` URL from the Render logs and link the bot phone.
5. Point UptimeRobot at `/health` every 5 minutes to keep the free instance
   awake, and at `/ready` if you want an alert when Liam is not linked.

Full instructions, including the exact environment variables and recovery
steps, are in [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md).

## Known limitations

- Render free has 0.1 CPU, 512 MB RAM, an ephemeral disk, and spins down after
  15 minutes without HTTP traffic. UptimeRobot prevents most spin-downs, but a
  restart can still happen at any time; Supabase is what makes that survivable.
- A Playwright screenshot or browser task can still exceed 512 MB because the
  Python agent creates its own Chromium. Keep browser work sequential and avoid
  large screenshots; the WhatsApp bridge itself uses only a few tens of MB.
- Group permissions and pending approvals are in memory. After a restart,
  members are asked again and approvals must be re-requested. `dm_open` lives
  on the ephemeral disk unless `LIAM_DM_OPEN` is set.
- `@whiskeysockets/baileys` is pinned to the stable 6.7.x line rather than the
  7.0 release candidate. Re-check `npm audit` when a 7.x stable release ships;
  do not force a downgrade that breaks the pin.
- WhatsApp automation is outside WhatsApp's Terms of Service. Aggressive
  outbound messaging increases the risk of an account ban; the rate limit and
  allowlist reduce, but do not remove, that risk.
- Image generation and voice notes need `GOOGLE_API_KEY`. Voice output is a
  valid WAV; it is converted to OGG/Opus only when `ffmpeg` is on `PATH`
  (installed in the Docker image).
