# Liam - WhatsApp AI Agent

Liam is a self-hosted WhatsApp agent. A Node bridge keeps a `whatsapp-web.js`
session alive and talks to a Python agent over newline-delimited JSON on
stdio. The Python side owns model routing, memory, and tools.

```
WhatsApp <-> whatsapp_bridge.js <-> JSON lines over stdio <-> agent.py
                                      |
                                      +-> authenticated 127.0.0.1 tool endpoint
                                          (send, image, voice, leave, stop, ...)
```

## Requirements

- Node.js **20+** (24.x tested)
- Python **3.10+** (3.12 tested)
- npm 10+
- Windows is the primary target (the launch scripts are `.bat`), but the code
  itself is cross-platform.

## Install

```powershell
npm ci
python -m pip install -r requirements.txt
python -m playwright install chromium   # for the screenshot tool
```

`npm ci` downloads Puppeteer's Chromium for WhatsApp Web. That download is
large; it is required for the bridge to start.

## Secrets

No API keys are stored in tracked source files. Provide them with environment
variables, or create a local `liam_secrets.py` (git-ignored) that defines:

```python
MOON_KEYS = ["...", "..."]
UNO_KEYS = ["...", "..."]
AGNES_KEY = "..."
HF_KEY = "..."
GOOGLE_API_KEY = ""   # optional: image generation and voice notes
```

Environment variables with the same names take precedence. `MOON_KEYS` and
`UNO_KEYS` accept a list or a comma-separated string when supplied through the
environment.

`liam_config.json` is shared by Python and Node and defines `owners` (phone
numbers in international format, digits only) and `admins` (name, relation,
and the names Liam may use). The bridge refuses to start if no owner is set.

## Run

```powershell
.\start_liam.bat
```

or:

```powershell
npm start
```

On first run, scan the QR code shown in the console. The QR image is written
to the runtime data directory and deleted after pairing.

## Runtime data

Runtime state lives outside the repository, in
`%LOCALAPPDATA%\LiamWhatsApp` by default. Set `LIAM_DATA_DIR` to override it.

| File / directory | Purpose |
| --- | --- |
| `liam_session/` | WhatsApp/Chrome login credentials - treat like a password |
| `tool_token` | 32-byte bearer token shared by the bridge and Python |
| `stop_flag`, `brain_state` | control state, validated and written atomically |
| `outbox/` | only directory the bridge will send media from |
| `qr.png` | transient pairing QR, deleted after authentication |

The memory database defaults to `liam_memory.db` in the project directory; set
`LIAM_DB` to move it. Legacy `.stop`, `.brain_state`, and session files are
migrated automatically on the next bridge start; old QR images are deleted.
`LIAM_PORT` moves the loopback tool endpoint (default `5678`), and Python's
client can follow it with `LIAM_BRIDGE_URL`.

## Security model

- The tool endpoint binds to `127.0.0.1` only and requires a bearer token.
- Requests must use `application/json`, a loopback `Host`, and no `Origin`
  header. Bodies are capped at 64 KB; outbound media at 25 MB.
- DM recipients must be an owner, an admin, or an entry in
  `LIAM_DM_ALLOWLIST`. Tool-initiated outbound sends are rate-limited to 20 per
  minute.
- Media must resolve inside `outbox/`; path traversal and symlink escapes are
  rejected. Outbound tools are owner-only.
- Screenshots accept public `http(s)` URLs only and reject credentials,
  localhost, private, link-local, and reserved addresses (SSRF guard).
- Errors returned over the endpoint are generic; secrets and stack traces stay
  in the console.
- Chrome runs with its sandbox enabled.

Do not expose the tool endpoint or the runtime data directory to a network.

## Tests and checks

```powershell
python -m unittest discover -s tests -v
node --test "tests/**/*.test.js"
python -m ruff check .
node --check whatsapp_bridge.js
npm audit --omit=dev
```

The bridge tests run against a temporary copy of `whatsapp_bridge.js` with a
stubbed WhatsApp client, so they never touch a real session or send messages.

## Known limitations

- `npm audit` still reports advisories in dependencies pinned by
  `whatsapp-web.js` (Puppeteer/Chromium and their transitive packages).
  Forcing the suggested downgrade of `whatsapp-web.js` makes the report worse
  and is not applied. Re-check when a new `whatsapp-web.js` release updates
  those dependencies.
- WhatsApp automation is outside WhatsApp's Terms of Service. Aggressive
  outbound messaging increases the risk of an account ban; the rate limit and
  allowlist reduce, but do not remove, that risk.
- A member who tags or quotes Liam in a group still receives a short,
  member-scoped answer. Outbound actions remain owner-only.
- Image generation and voice notes need `GOOGLE_API_KEY`. Voice output is a
  valid WAV; it is converted to OGG/Opus only when `ffmpeg` is on `PATH`.
