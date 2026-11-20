// Baileys speaks the WhatsApp Web protocol directly. It replaces
// whatsapp-web.js/Puppeteer so the bridge does not need Chromium at all, which
// is what makes a 512 MiB Render free instance enough.
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  Browsers,
  isJidGroup,
  getContentType,
  normalizeMessageContent,
} = require("@whiskeysockets/baileys");
const { spawn, spawnSync } = require("child_process");

// Timestamp of this process. /status exposes it so an OOM kill or crash shows up
// as a fresh start instead of silently looking like a normal reconnect.
const STARTED_AT = Date.now();

const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const util = require("util");

// Keep the last few console lines in memory so /diag?probe=logs can show what
// the bridge actually saw. Capped, never persisted, and only returned when the
// token-protected logs probe is asked for (the lines can contain message text).
const RECENT_LOGS = [];
function safeInspect(value) {
  try {
    return typeof value === "string" ? value : util.inspect(value, { depth: 2, breakLength: 120 });
  } catch (e) { return String(value); }
}
// Delivery-token lines are the ones that explain an outbound 463 rejection, so
// keep a small dedicated ring of them that cannot be flushed out by noisy
// debug output from everything else.
const TOKEN_LOGS = [];
const TOKEN_LOG_RE = /tctoken|privacy token|privacy_token|463|reachout|reach-out|prenotif|prenotification/i;
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    try {
      const line = args.map(safeInspect).join(" ").slice(0, 800);
      RECENT_LOGS.push({ at: Date.now(), level, line });
      while (RECENT_LOGS.length > 400) RECENT_LOGS.shift();
      if (TOKEN_LOG_RE.test(line)) {
        TOKEN_LOGS.push({ at: Date.now(), level, line });
        while (TOKEN_LOGS.length > 40) TOKEN_LOGS.shift();
      }
    } catch (e) {}
    original(...args);
  };
}
let sync;
try { sync = require("./supabase_sync"); }
catch (e) { sync = { restoreSession: async()=>({restored:false}), restoreDb: async()=>({restored:false}), backupSession: async()=>({ok:false}), backupDb: async()=>({ok:false}), backupNow: async()=>({ok:false}), sanitizeChromeLocks: ()=>0, startPeriodicBackup: ()=>null, stopPeriodicBackup: ()=>{}, configured: ()=>false, uploadState: async()=>({ok:false}), downloadState: async()=>({restored:false}) }; }

// A fatal error must not leave a half-alive process that Render keeps routing
// traffic to. Flush the small persisted state synchronously, then exit non-zero
// so the supervisor restarts the service. Guard against running more than once.
let fatalHandlersInstalled = false;
function fatalFlushAndExit(kind, value) {
  const detail = String(value && value.message ? value.message : value).slice(0, 200);
  try { noteWaEvent(kind, detail); } catch (e) {}
  console.log(`\n💀 ${kind}:`, String(value && value.stack ? value.stack : value));
  if (fatalHandlersInstalled) return;
  fatalHandlersInstalled = true;
  try { saveBridgeStateLocal(); } catch (e) {}
  try { if (sync && sync.stopPeriodicBackup) sync.stopPeriodicBackup(); } catch (e) {}
  // Give an in-flight HTTP response a tick to complete before exiting.
  setTimeout(() => process.exit(1), 250).unref?.();
}
process.on("unhandledRejection", (r) => fatalFlushAndExit("UNHANDLED REJECTION", r));
process.on("uncaughtException", (e) => fatalFlushAndExit("UNCAUGHT EXCEPTION", e));

// ---------------------------------------------------------------------------
// Paths and shared config
// ---------------------------------------------------------------------------
const BASE_DIR = __dirname;
const DATA_DIR = process.env.LIAM_DATA_DIR || path.join(
  process.env.LOCALAPPDATA || os.homedir(), "LiamWhatsApp");
const SESSION_DIR = path.join(DATA_DIR, "liam_session");
const SESSION_PROFILE_DIR = path.join(SESSION_DIR, "session");
const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
const TOKEN_FILE = path.join(DATA_DIR, "tool_token");
const PAIR_TOKEN_FILE = path.join(DATA_DIR, "pair_token");
const KNOWN_MEMBERS_FILE = path.join(DATA_DIR, "known_members.json");
const STOP_FILE = path.join(DATA_DIR, "stop_flag");
// Deliberate "stay down" state. A plain hard stop is transient: the watchdog
// brings the agent back. This marker tells the watchdog the owner meant it.
const OFFLINE_FILE = path.join(DATA_DIR, "agent_offline");
const QR_FILE = path.join(DATA_DIR, "qr.png");
const DM_OPEN_FILE = path.join(DATA_DIR, "dm_open");

const MAX_BODY = 64 * 1024;
const MAX_MEDIA = 25 * 1024 * 1024;
const OUTBOUND_WINDOW = 60 * 1000;
const OUTBOUND_MAX = 20;

// A mistyped numeric env var (e.g. "10m") makes Number.parseInt return NaN, and
// NaN in Math.max stays NaN. That silently breaks a timer or a comparison, so
// every configurable number goes through envInt() and falls back to the default.
function envInt(name, fallback, min, max) {
  // A value like "10m" must be rejected, not silently parsed as 10. Number.parseInt
  // accepts a leading integer and ignores the rest, which would set a wildly
  // wrong timer, so require the whole string to be an integer first.
  const raw = process.env[name];
  const parsed = typeof raw === "string" && /^[+-]?\d+$/.test(raw.trim())
    ? Number.parseInt(raw.trim(), 10) : NaN;
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

const PERMISSION_TTL_MS = envInt("LIAM_GROUP_PERMISSION_MS", 3 * 60 * 60 * 1000, 60_000);
const PENDING_TTL_MS = envInt("LIAM_PENDING_TTL_MS", 30 * 60 * 1000, 60_000);
const TOOL_APPROVAL_TTL_MS = envInt("LIAM_TOOL_APPROVAL_MS", 10 * 60 * 1000, 60_000);
// Minimum gap between two pairing-code requests. WhatsApp blocks a number that
// asks repeatedly, and each request restarts that block.
const PAIRING_COOLDOWN_MS = envInt("LIAM_PAIRING_COOLDOWN_MS", 120000, 60_000);
// WhatsApp's own rate-limit wait. One value drives both the reconnect delay and
// the text shown to the operator, so the two can never disagree.
const RATE_LIMIT_COOLDOWN_MS = envInt("LIAM_RATE_LIMIT_COOLDOWN_MS", 5 * 60 * 1000, 60_000);
const MAX_PENDING = 40;

function resolvePort() {
  // "0" is a valid explicit value (an ephemeral port, used by the tests), so pick
  // the first variable that is actually set rather than using ||, which would
  // skip an empty string but is easy to get wrong for zero.
  let raw = null;
  for (const name of ["PORT", "LIAM_PORT"]) {
    if (process.env[name] != null && String(process.env[name]).trim() !== "") {
      raw = String(process.env[name]).trim();
      break;
    }
  }
  if (raw === null) raw = "5678";
  if (!/^\d+$/.test(raw)) {
    throw new Error("PORT/LIAM_PORT must be a TCP port between 0 and 65535");
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT/LIAM_PORT must be a TCP port between 0 and 65535");
  }
  return port;
}
const PORT = resolvePort();

for (const dir of [DATA_DIR, OUTBOX_DIR]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) {}
}

// The marker survives a bridge restart, so a deploy cannot silently undo the
// owner's decision to keep Liam offline.
let agentOffline = false;
try { agentOffline = fs.existsSync(OFFLINE_FILE); } catch (e) { agentOffline = false; }
function setAgentOffline(on) {
  agentOffline = !!on;
  try {
    if (agentOffline) writeFileAtomic(OFFLINE_FILE, "1");
    else { try { fs.unlinkSync(OFFLINE_FILE); } catch (e) {} }
  } catch (e) {
    console.log("warn: could not persist offline state:",
      String(e && e.message ? e.message : e).slice(0, 160));
  }
}

const CONFIG = require("./liam_config.json");

function bareId(id) { return String(id || "").split("@")[0].split(":")[0]; }

const OWNERS = (Array.isArray(CONFIG.owners) ? CONFIG.owners : [])
  .map(bareId).filter((p) => /^\d{6,20}$/.test(p));
const ADMINS = {};
for (const [phone, info] of Object.entries(CONFIG.admins || {})) {
  const p = bareId(phone);
  if (/^\d{6,20}$/.test(p) && info && typeof info === "object") ADMINS[p] = info;
}
if (!OWNERS.length) throw new Error("liam_config.json must list at least one owner");

const DM_ALLOW = new Set([
  ...OWNERS,
  ...Object.keys(ADMINS),
  ...String(process.env.LIAM_DM_ALLOWLIST || "")
    .split(",").map(bareId).filter((p) => /^\d{6,20}$/.test(p)),
]);

// Known group members are people Liam has actually seen in a group. They are
// only allowed to DM after the owner runs .allowdm.
const KNOWN_MEMBERS_MAX = 5000;
const knownMembers = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_FILE, "utf8"));
  if (Array.isArray(raw)) raw.map(bareId).filter((p) => /^\d{6,20}$/.test(p)).forEach((p) => knownMembers.add(p));
} catch (e) {}
// Keep the in-memory set bounded too, not only the file. A long-lived process
// that sees many group members otherwise grows this set without limit.
function trimKnownMembers() {
  while (knownMembers.size > KNOWN_MEMBERS_MAX) {
    knownMembers.delete(knownMembers.values().next().value);
  }
}
trimKnownMembers();
function saveKnownMembers() {
  trimKnownMembers();
  try {
    writeFileAtomic(KNOWN_MEMBERS_FILE, JSON.stringify([...knownMembers]));
  } catch (e) {}
}
function rememberKnownMember(phone) {
  const p = bareId(phone);
  if (!/^\d{6,20}$/.test(p) || knownMembers.has(p)) return;
  knownMembers.add(p);
  trimKnownMembers();
  saveKnownMembers();
}

function copyLegacy(src, dest, mode = 0o600) {
  try {
    if (!fs.existsSync(src)) return;
    if (fs.existsSync(dest)) {
      // The migration already happened. Drop the source only when it is an
      // identical leftover; a different file may contain newer user data.
      try {
        if (fs.readFileSync(src).equals(fs.readFileSync(dest))) fs.rmSync(src, { force: true });
      } catch (e) {}
      return;
    }
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, mode); } catch (e) {}
    fs.rmSync(src, { force: true });
  } catch (e) { console.log("⚠️ could not migrate " + src + ": " + String(e)); }
}

// Move control files and session data out of the project directory. The brain
// marker is only migrated here; the live agent keeps its own history in SQLite.
copyLegacy(path.join(BASE_DIR, ".brain_state"), path.join(DATA_DIR, "brain_state"));
copyLegacy(path.join(BASE_DIR, ".stop"), STOP_FILE);
const LEGACY_SESSION = path.join(BASE_DIR, "liam_session");
if (!fs.existsSync(SESSION_DIR) && fs.existsSync(LEGACY_SESSION)) {
  try { fs.renameSync(LEGACY_SESSION, SESSION_DIR); }
  catch (e) {
    try {
      fs.cpSync(LEGACY_SESSION, SESSION_DIR, { recursive: true });
      fs.rmSync(LEGACY_SESSION, { recursive: true, force: true });
    } catch (e2) { console.log("⚠️ could not move session data: " + String(e2)); }
  }
  try { fs.chmodSync(SESSION_DIR, 0o700); } catch (e) {}
}

// Remove QR images left behind by earlier runs. Linking now uses an
// 8-character phone code, but old deployments may still have these files.
for (const name of ["liam_qr.png", "whatsapp_qr.png", "scan_liam.png"]) {
  try { fs.rmSync(path.join(BASE_DIR, name), { force: true }); } catch (e) {}
}
try { fs.rmSync(QR_FILE, { force: true }); } catch (e) {}

// Old whatsapp-web.js builds left a Chromium profile and a web-version cache
// behind. Nothing reads them any more, so remove them to keep the archive small.
for (const stale of [path.join(BASE_DIR, ".wwebjs_cache"), path.join(BASE_DIR, "node_modules", "whatsapp-web.js")]) {
  try { if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true }); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Local tool endpoint token and pairing token
// ---------------------------------------------------------------------------
function loadToken() {
  let token = "";
  try { token = fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch (e) {}
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    try { fs.chmodSync(TOKEN_FILE, 0o600); } catch (e) {}
  }
  return token;
}
const TOOL_TOKEN = loadToken();
// Owner-only tool actions need a second token that the normal loop token cannot
// derive. It is regenerated on every bridge start and passed only to the spawned
// agent, so a leaked tool token cannot claim sender=owner and run shell commands.
const OWNER_TOKEN = crypto.randomBytes(32).toString("hex");

function loadPairToken() {
  const fromEnv = String(process.env.LIAM_PAIR_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  let token = "";
  try { token = fs.readFileSync(PAIR_TOKEN_FILE, "utf8").trim(); } catch (e) {}
  if (!/^[a-f0-9]{32,128}$/.test(token)) {
    token = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(PAIR_TOKEN_FILE, token, { mode: 0o600 });
    try { fs.chmodSync(PAIR_TOKEN_FILE, 0o600); } catch (e) {}
  }
  return token;
}
const PAIR_TOKEN = loadPairToken();
const PUBLIC_URL = String(
  process.env.LIAM_PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.RENDER_EXTERNAL_HOSTNAME ? "https://" + process.env.RENDER_EXTERNAL_HOSTNAME : "") ||
  ""
).replace(/\/+$/, "");
// No owner-specific number baked into the code. Prefer an explicit override,
// then the first configured owner, then an empty value the page can leave blank.
const BOT_PHONE = String(process.env.LIAM_BOT_PHONE || OWNERS[0] || "").replace(/\D/g, "");

function writeFileAtomic(file, value) {
  const temp = file + "." + process.pid + "." + Date.now() + ".tmp";
  try {
    fs.writeFileSync(temp, value, { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch (e) {}
    fs.renameSync(temp, file);
  } catch (e) {
    try { fs.rmSync(temp, { force: true }); } catch (e2) {}
    throw e;
  }
}

// ---------------------------------------------------------------------------
// WhatsApp state
// ---------------------------------------------------------------------------
let waState = "starting";        // starting | restoring | needs_qr | linking | ready | disconnected | error
let waStateDetail = "";
let waInitError = "";
let waInitPromise = null;
let waLastQrAt = 0;              // last time the socket was ready to pair
let lastPairCode = null;
let lastPairAt = 0;
let pairingError = "";
let authAt = 0;
let pairingInFlight = null;
let pairingEpoch = 0;

// The one live Baileys socket. `connecting` covers the async gap while a new
// socket is being created; `sockReadyForPairing` becomes true only after
// WhatsApp sends the first QR payload, which is the moment requestPairingCode()
// is allowed (calling it earlier fails with "couldn't link device").
let sock = null;
let connecting = false;
let sockReadyForPairing = false;
let registered = false;
let readyHandled = false;
let reconnectTimer = null;
let reconnectDelayMs = 3000;
let waVersion = null;
let closeCount = 0;
let closeWindowStart = 0;

// Small ring buffer of connection events. Render's free logs are painful to
// read from a phone, so /diag exposes the last few events instead.
const waEvents = [];
function noteWaEvent(name, extra) {
  try {
    waEvents.push({ at: Date.now(), name, detail: extra ? String(extra).slice(0, 200) : "" });
    if (waEvents.length > 30) waEvents.shift();
  } catch (e) {}
}

function setWaState(state, detail = "") {
  waState = state;
  waStateDetail = detail || "";
}

// True while the phone is completing an 8-character code login. Nothing may
// restart the socket in this window: doing so cancels the handshake and leaves
// a "zombie" device on the phone while the server falls back to a new code.
function linkHandshakeActive() {
  return waState === "linking" &&
    Date.now() - Math.max(lastPairAt || 0, authAt || 0) < 5 * 60 * 1000;
}

// Real container memory. Render kills the instance when the free plan's limit
// is exceeded, so this is the number that matters.
function containerMemoryInfo() {
  const readNum = (file) => {
    try {
      const raw = Number(fs.readFileSync(file, "utf8").trim());
      return Number.isFinite(raw) && raw > 0 ? raw : null;
    } catch (e) { return null; }
  };
  const used = readNum("/sys/fs/cgroup/memory.current") ?? readNum("/sys/fs/cgroup/memory/memory.usage_in_bytes");
  const limit = readNum("/sys/fs/cgroup/memory.max") ?? readNum("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  let anon = null, file = null;
  try {
    for (const line of fs.readFileSync("/sys/fs/cgroup/memory.stat", "utf8").split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length !== 2) continue;
      if (parts[0] === "anon" || parts[0] === "total_rss") anon = anon ?? Number(parts[1]);
      if (parts[0] === "file" || parts[0] === "total_cache") file = file ?? Number(parts[1]);
    }
  } catch (e) {}
  const mib = (n) => (Number.isFinite(n) && n > 0 ? Math.round(n / 1048576) : null);
  return { usedMiB: mib(used), limitMiB: mib(limit), anonMiB: mib(anon), fileMiB: mib(file) };
}

function containerMemoryMiB() {
  return containerMemoryInfo().usedMiB;
}

// Baileys keeps its login in this directory: creds.json plus a handful of
// app-state keys. It lives inside SESSION_DIR so it travels with the Supabase
// archive under the same "liam_session/session" path as before.
const CREDS_FILE = path.join(SESSION_PROFILE_DIR, "creds.json");
function profileHasCredentials() {
  // A truncated or corrupt creds.json is worse than no credentials: it makes
  // boot trust a half-written profile. Require a readable JSON object before
  // treating the profile as usable.
  try {
    const raw = fs.readFileSync(CREDS_FILE, "utf8");
    const data = JSON.parse(raw);
    return !!(data && typeof data === "object" && !Array.isArray(data));
  } catch (e) { return false; }
}
function hasSessionData() { return profileHasCredentials(); }

// A marker written only after WhatsApp confirms the login. It lives next to the
// credentials (inside SESSION_DIR, so it travels with the Supabase archive).
// Boot uses it to tell a real linked session from a half-finished pairing:
// Baileys writes creds.json before the phone confirms the code, so the file
// alone cannot prove that WhatsApp is linked.
const LINK_MARKER = path.join(SESSION_DIR, "wa_linked.json");
function hasLinkMarker() {
  try { return fs.existsSync(LINK_MARKER); } catch (e) { return false; }
}
function readLinkMarker() {
  try { return JSON.parse(fs.readFileSync(LINK_MARKER, "utf8")); } catch (e) { return null; }
}
function markLinked(extra) {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(LINK_MARKER,
      JSON.stringify({ at: Date.now(), ...(extra || {}) }), { mode: 0o600 });
  } catch (e) { console.log("warn: could not write the linked marker:", String(e)); }
}
function clearLinkMarker() {
  try { fs.rmSync(LINK_MARKER, { force: true }); } catch (e) {}
}
function removeQrFile() {
  try { fs.rmSync(QR_FILE, { force: true }); } catch (e) {}
}

function loadDmOpen() {
  // The persisted .allowdm / .disallowdm decision is authoritative. The env var
  // is only a first-run default used when no saved decision file exists yet;
  // otherwise an old env value would override what the owner last typed.
  try { return fs.readFileSync(DM_OPEN_FILE, "utf8").trim() === "1"; }
  catch (e) {
    if (process.env.LIAM_DM_OPEN != null) return String(process.env.LIAM_DM_OPEN || "0") === "1";
    return false;
  }
}
let dmOpen = loadDmOpen();
function saveDmOpen() {
  try { writeFileAtomic(DM_OPEN_FILE, dmOpen ? "1" : "0"); } catch (e) {}
}
function setDmOpen(value) {
  dmOpen = !!value;
  saveDmOpen();
}
function dmAllowed(phone) {
  const p = bareId(phone);
  return OWNERS.includes(p) || (p in ADMINS) || (dmOpen && knownMembers.has(p));
}
const TEMP = {};                 // group permissions: TEMP[groupJid][phone] = +/-timestamp
const lastLiam = {};             // recent message IDs Liam sent per chat (reply-to detection)
const LAST_LIAM_MAX = 20;
function rememberLiamMessage(jid, id) {
  if (!jid || !id) return;
  const list = lastLiam[jid] || (lastLiam[jid] = []);
  list.push(id);
  list.splice(0, Math.max(0, list.length - LAST_LIAM_MAX));
}
function isLiamMessage(jid, id) {
  return !!(jid && id && lastLiam[jid] && lastLiam[jid].includes(id));
}
const pendingPerms = new Map();  // id -> { id, jid, phone, text, ts }
const pendingTools = new Map();  // id -> { id, action, payload, actor, chat, isGroup, ts }
// The single outer safety net. Liam's tools are otherwise unlimited, so this is
// the only thing that ends a genuinely stuck turn instead of hanging forever.
const ASK_TIMEOUT_MS = envInt("LIAM_ASK_TIMEOUT_MS", 3600000, 15000);
// Baileys pings WhatsApp every interval, and gives up on a silent socket after
// interval + 5s. WhatsApp drops the stream (428) when we cannot answer in time,
// which is what happens when a heavy job (headless Chromium, a backup) blocks
// the event loop on this small box. A shorter interval keeps our pings inside
// WhatsApp's window, so a single missed beat is not fatal. Configurable so it
// can be tuned without a code change.
const WA_KEEPALIVE_MS = envInt("LIAM_WA_KEEPALIVE_MS", 25000, 15000, 120000);
// Shown to the person when the agent cannot answer (crash, provider outage or
// timeout). A silent failure looks like Liam ignoring them, which is worse.
const SERVER_DOWN_TEXT = String(
  process.env.LIAM_DOWN_TEXT ||
  "My server is down right now, so I can't answer - please give me a minute and try again."
).slice(0, 500);
let agentProc = null;            // spawned python agent process
let agentPending = null;         // { resolve, reject, timeout, id } for the one in-flight request
let agentRequestId = 0;
let agentQueue = Promise.resolve();

// Safe diagnostics for /diag. Never store message text: only counts, timestamps,
// a masked last-4 phone, and the last error. This is how we tell a routing
// problem from a model/provider problem without access to Render's log stream.
let inboundCount = 0;
let lastInboundAt = 0;
let lastInboundKind = "";
let lastInboundPhone = "";
let lastInboundError = "";
let lastInboundFromType = "";
let lastOutboundAt = 0;
let lastSendTargetType = "";
let lastSendError = "";
// The last few outbound message ids and their delivery acknowledgements. A send
// that "succeeds" but never arrives shows up here as a missing/never-advanced
// ack, which tells a delivery problem apart from a routing one.
const recentSends = [];
const outboundAcks = new Map();
const ackSamples = [];
let messagesUpdateCount = 0;
let receiptUpdateCount = 0;
// Raw wire evidence, so a send that is accepted but never delivered can be told
// apart from a send that never leaves the socket at all.
let ackNodeCount = 0;
const ackNodeSamples = [];
const outFrameSizes = [];
function noteAckNode(node) {
  ackNodeCount += 1;
  try {
    const a = (node && node.attrs) || {};
    ackNodeSamples.push({
      cls: a.class || "",
      err: a.error || "",
      type: a.type || "",
      id: String(a.id || "").slice(-6),
      from: jidType(a.from),
    });
    while (ackNodeSamples.length > 12) ackNodeSamples.shift();
    // 463 = the server refused a 1:1 message (reach-out time-lock / missing
    // privacy token). Re-read the lock so the block is visible and respected.
    if (String(a.error || "") === "463") {
      lastSendError = "WhatsApp refused the message (error 463: reach-out time-lock or missing privacy token)";
      console.log(`warn: WhatsApp refused an outgoing message with error 463${a.from ? ` (to ${jidType(a.from)})` : ""}`);
      void refreshReachoutLock();
    }
  } catch (e) {}
}
function watchSocketWire(socket) {
  try {
    const ws = socket && socket.ws;
    if (!ws || ws.__liamWired) return;
    ws.__liamWired = true;
    // Every server acknowledgement node, not only the bad ones Baileys surfaces.
    ws.on("CB:ack", noteAckNode);
    // Outgoing frame sizes: a real encrypted message is hundreds of bytes; a
    // stanza with no participant nodes is only a handful.
    const origSend = ws.send.bind(ws);
    ws.send = (...args) => {
      try {
        const data = args[0];
        outFrameSizes.push(data && (data.length || data.byteLength || 0));
        while (outFrameSizes.length > 20) outFrameSizes.shift();
      } catch (e) {}
      return origSend(...args);
    };
  } catch (e) {}
}

// WhatsApp can put a number under a reach-out time-lock, which blocks every
// companion device (this one included) from sending for a set period. A send
// still "succeeds" locally but comes back as ack error 463, so the reply looks
// sent and never arrives. Track the server's own view of that lock so it is
// visible, and so we stop hammering a blocked number.
let reachoutLock = null;
function reachoutLockActive() {
  if (!reachoutLock || !reachoutLock.isActive) return false;
  // If the announced end time has passed, try sending again; a fresh 463 will
  // set the lock again if WhatsApp has extended it.
  if (reachoutLock.endsAt && Date.parse(reachoutLock.endsAt) <= Date.now()) return false;
  return true;
}
let reachoutRefreshInFlight = null;
async function refreshReachoutLock() {
  if (reachoutRefreshInFlight) return reachoutRefreshInFlight;
  reachoutRefreshInFlight = (async () => {
    try {
      if (!sock || typeof sock.fetchAccountReachoutTimelock !== "function") return;
      const info = await sock.fetchAccountReachoutTimelock();
      const checkedAt = Date.now();
      const next = info ? {
        isActive: !!info.isActive,
        enforcementType: info.enforcementType || null,
        endsAt: info.timeEnforcementEnds ? new Date(info.timeEnforcementEnds).toISOString() : null,
        checkedAt,
      } : { isActive: false, enforcementType: null, endsAt: null, checkedAt };
      // A slower check started before a newer one must not overwrite it.
      if (reachoutLock && Number(reachoutLock.checkedAt || 0) >= checkedAt) return;
      reachoutLock = next;
      if (reachoutLock && reachoutLock.isActive) {
        console.log(`warn: WhatsApp is blocking outgoing messages (${reachoutLock.enforcementType || "restriction"})`
          + (reachoutLock.endsAt ? ` until ${reachoutLock.endsAt}` : ""));
      } else if (!reachoutLockActive()) {
        // The block has lifted: release anything we held back while it was on.
        void flushHeldReplies();
      }
    } catch (e) { /* keep the last known value on a failed check */ }
  })();
  try { return await reachoutRefreshInFlight; }
  finally { reachoutRefreshInFlight = null; }
}

// While WhatsApp is time-locking the number, replies cannot be delivered, so
// instead of dropping them they wait here and go out as soon as the block
// lifts. Bounded in count and age so a long block cannot replay a flood of
// stale answers or grow without limit.
const heldReplies = [];
const HELD_REPLY_MAX = 20;
const HELD_REPLY_TTL_MS = 3 * 60 * 60 * 1000;
function holdReply(target, text, options) {
  try {
    const body = String(text || "");
    // A retry after a failed send can reach here more than once for the same
    // answer. Keeping one item avoids delivering it twice when the lock lifts.
    const existing = heldReplies.find((h) => h.target === target && h.text === body);
    if (existing) {
      existing.at = Date.now();
      if (options) existing.options = options;
    } else {
      heldReplies.push({ target, text: body, options, at: Date.now(), sentChunks: 0 });
      while (heldReplies.length > HELD_REPLY_MAX) heldReplies.shift();
    }
    scheduleBridgeStateSave();
    console.log(`warn: holding a reply for ${jidType(target)} until WhatsApp stops blocking sends`);
  } catch (e) {}
}
let flushingHeldReplies = false;
async function flushHeldReplies() {
  if (flushingHeldReplies || reachoutLockActive() || !heldReplies.length) return;
  flushingHeldReplies = true;
  try {
    while (heldReplies.length) {
      const item = heldReplies[0];
      if (Date.now() - item.at > HELD_REPLY_TTL_MS) { heldReplies.shift(); continue; }
      try {
        const sent = await sendLong(item.target, item.text, item.options, (sentChunks) => {
          // If a fresh 463 arrives mid-reply, the next flush starts from the
          // chunk after the last one WhatsApp accepted instead of resending all.
          item.sentChunks = sentChunks;
          scheduleBridgeStateSave();
        }, item.sentChunks || 0);
        heldReplies.shift();
        console.log(`info: delivered a held reply to ${jidType(item.target)} (id ${messageId(sent) || "?"})`);
      } catch (e) {
        if (e && e.reachoutLocked) break; // still blocked; keep it for the next check
        heldReplies.shift(); // a real error would never succeed, so do not loop
        console.log(`warn: dropped a held reply (${String(e && e.message ? e.message : e).slice(0, 120)})`);
      }
    }
  } finally {
    flushingHeldReplies = false;
    scheduleBridgeStateSave();
  }
}

// ---------------------------------------------------------------------------
// Small persistent state: held replies, group permissions, pending approvals
// ---------------------------------------------------------------------------
// On Render's free plan the disk is wiped on every redeploy, so a copy in
// Supabase is the only thing that actually survives a restart. The local file
// is written first (cheap, and survives an in-place process restart) and the
// small JSON object is pushed to Supabase on a short debounce and on shutdown.
const BRIDGE_STATE_OBJECT = "bridge_state.json";
const BRIDGE_STATE_FILE = path.join(DATA_DIR, "bridge_state.json");
let bridgeStateSaveTimer = null;

const STATE_MAP_MAX = 5000;
const STATE_LIAM_MAX = 200;
function boundedEntries(map, max = STATE_MAP_MAX) {
  return Object.fromEntries([...map.entries()].slice(0, max));
}

function bridgeStateSnapshot() {
  return {
    v: 1,
    savedAt: Date.now(),
    // Render's free disk is wiped on redeploy, so the offline decision must
    // travel with the rest of the state or a deploy would quietly bring the
    // agent back online against the owner's wishes.
    offline: agentOffline,
    // Deep-enough copy: the caller may mutate TEMP before the debounced upload,
    // and the snapshot must reflect the state at the moment it was taken.
    temp: Object.fromEntries(Object.entries(TEMP).map(([jid, map]) => [jid, { ...map }])),
    perms: [...pendingPerms.values()].map((p) => ({
      id: p.id, jid: p.jid, phone: p.phone, text: p.text, ts: p.ts,
      promptedText: p.promptedText, promptCount: p.promptCount, frozen: p.frozen,
    })),
    tools: [...pendingTools.values()].map((t) => ({
      id: t.id, action: t.action, payload: t.payload, actor: t.actor,
      chat: t.chat, isGroup: t.isGroup, ts: t.ts,
    })),
    // The quoted message is intentionally dropped: it is a live Baileys object
    // that cannot be safely rehydrated after a restart, and delivering the text
    // matters more than the quote. sentChunks keeps a partially delivered reply
    // from being sent twice when the lock lifts.
    held: heldReplies.map((h) => ({ target: h.target, text: h.text, at: h.at, sentChunks: h.sentChunks || 0 })),
    // These used to be rebuilt from scratch on every redeploy, losing DM
    // decisions, learned LID identities and reply-to context.
    dmOpen,
    known: [...knownMembers].slice(0, KNOWN_MEMBERS_MAX),
    lids: {
      cache: boundedEntries(lidCache),
      contacts: boundedEntries(lidContacts),
      sources: boundedEntries(lidSources),
    },
    lastLiam: Object.fromEntries(Object.entries(lastLiam).slice(0, STATE_LIAM_MAX)
      .map(([jid, list]) => [jid, list.slice(-LAST_LIAM_MAX)])),
    recentIds: [...recentMessageIds].slice(-500),
    outbound: outboundLog.slice(-OUTBOUND_MAX),
  };
}

function applyBridgeState(state) {
  if (!state || typeof state !== "object") return;
  // A state file is a full snapshot, not a delta. Applying twice must not
  // duplicate held replies or resurrect approvals that were already deleted.
  for (const key of Object.keys(TEMP)) delete TEMP[key];
  pendingPerms.clear();
  pendingTools.clear();
  heldReplies.length = 0;

  if (state.temp && typeof state.temp === "object") {
    for (const [jid, map] of Object.entries(state.temp)) {
      if (map && typeof map === "object") TEMP[jid] = { ...map };
    }
  }
  for (const p of Array.isArray(state.perms) ? state.perms : []) {
    if (p && p.id && typeof p.jid === "string" && typeof p.text === "string") {
      pendingPerms.set(p.id, { ...p, quoted: null });
    }
  }
  for (const t of Array.isArray(state.tools) ? state.tools : []) {
    if (t && t.id && t.payload && typeof t.action === "string") pendingTools.set(t.id, t);
  }
  if (typeof state.dmOpen === "boolean") {
    dmOpen = state.dmOpen;
    saveDmOpen();
  }
  const known = Array.isArray(state.known) ? state.known : [];
  knownMembers.clear();
  for (const value of known.slice(0, KNOWN_MEMBERS_MAX)) {
    const p = bareId(value);
    if (/^\d{6,20}$/.test(p)) knownMembers.add(p);
  }
  trimKnownMembers();
  if (state.lids && typeof state.lids === "object") {
    const loadMap = (value, target) => {
      if (!value || typeof value !== "object") return;
      for (const [k, v] of Object.entries(value).slice(0, STATE_MAP_MAX)) {
        target.set(bareId(k), v);
      }
    };
    lidCache.clear();
    lidContacts.clear();
    lidSources.clear();
    loadMap(state.lids.cache, lidCache);
    loadMap(state.lids.contacts, lidContacts);
    loadMap(state.lids.sources, lidSources);
    saveLidMap();
  }
  for (const key of Object.keys(lastLiam)) delete lastLiam[key];
  if (state.lastLiam && typeof state.lastLiam === "object") {
    for (const [jid, list] of Object.entries(state.lastLiam).slice(0, STATE_LIAM_MAX)) {
      if (Array.isArray(list)) lastLiam[jid] = list.slice(-LAST_LIAM_MAX);
    }
  }
  recentMessageIds.clear();
  for (const id of (Array.isArray(state.recentIds) ? state.recentIds : []).slice(-500)) {
    if (id) recentMessageIds.add(String(id));
  }
  if (Array.isArray(state.outbound)) {
    outboundLog.length = 0;
    for (const at of state.outbound.slice(-OUTBOUND_MAX)) {
      if (Number.isFinite(Number(at))) outboundLog.push(Number(at));
    }
  }
  const now = Date.now();
  for (const h of Array.isArray(state.held) ? state.held : []) {
    if (!h || !h.target || typeof h.text !== "string") continue;
    if (now - Number(h.at || 0) > HELD_REPLY_TTL_MS) continue;
    heldReplies.push({
      target: h.target, text: h.text, options: undefined, at: Number(h.at) || now,
      sentChunks: Math.max(0, Number.parseInt(h.sentChunks, 10) || 0),
    });
  }
  while (heldReplies.length > HELD_REPLY_MAX) heldReplies.shift();
  trimPending(pendingPerms);
  trimPending(pendingTools);
  sweepTemp(now); // drop anything that expired while we were down
  // Older snapshots have no offline field; leave the file-based value alone
  // in that case rather than guessing.
  if (typeof state.offline === "boolean") setAgentOffline(state.offline);
}

function saveBridgeStateLocal() {
  try { writeFileAtomic(BRIDGE_STATE_FILE, JSON.stringify(bridgeStateSnapshot())); } catch (e) {}
}

// Debounced so a burst of changes (an approval that also flushes replies) makes
// one local write and one Supabase upload, not several.
function scheduleBridgeStateSave() {
  // The local copy is cheap and must exist immediately. A crash or redeploy
  // inside the debounce window would otherwise lose the change from both disk
  // and the cloud. Only the remote upload waits.
  saveBridgeStateLocal();
  if (bridgeStateSaveTimer) return;
  bridgeStateSaveTimer = setTimeout(() => {
    bridgeStateSaveTimer = null;
    try {
      if (sync.uploadState) {
        sync.uploadState(DATA_DIR, BRIDGE_STATE_OBJECT, bridgeStateSnapshot())
          .then(() => {}, () => {});
      }
    } catch (e) {}
  }, 4000);
  if (typeof bridgeStateSaveTimer.unref === "function") bridgeStateSaveTimer.unref();
}

async function loadBridgeState() {
  let local = null;
  try { local = JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, "utf8")); } catch (e) {}
  let remote = null;
  try {
    if (sync.downloadState) {
      const res = await sync.downloadState(BRIDGE_STATE_OBJECT);
      if (res && res.restored) remote = res.value;
    }
  } catch (e) {}
  // Prefer whichever copy is newer, so a failed upload cannot roll state back.
  let state = null;
  if (local && remote) state = Number(local.savedAt || 0) >= Number(remote.savedAt || 0) ? local : remote;
  else state = local || remote;
  if (state) applyBridgeState(state);
}

const ACK_NAMES = { 0: "error", 1: "pending", 2: "server", 3: "delivered", 4: "read", 5: "played" };
function ackName(status) {
  const n = Number(status);
  return Number.isFinite(n) ? (ACK_NAMES[n] || String(n)) : "";
}
function recordSend(id, to) {
  if (!id) return;
  recentSends.push({ id, to, at: Date.now() });
  while (recentSends.length > 5) recentSends.shift();
}
function recordAcks(updates) {
  for (const item of Array.isArray(updates) ? updates : []) {
    const id = item && item.key && item.key.id;
    const status = item && item.update && item.update.status;
    if (!id || status === undefined || status === null) continue;
    const prior = outboundAcks.get(id) || { to: jidType(item.key && item.key.remoteJid) };
    outboundAcks.set(id, { status: ackName(status), at: Date.now(), to: prior.to || "" });
    ackSamples.push({ id: String(id).slice(-6), to: jidType(item.key && item.key.remoteJid), status: ackName(status), at: Date.now() });
    while (ackSamples.length > 8) ackSamples.shift();
  }
  if (outboundAcks.size > 40) {
    for (const key of outboundAcks.keys()) {
      if (outboundAcks.size <= 40) break;
      outboundAcks.delete(key);
    }
  }
}
function recentSendReport() {
  return recentSends.slice(-5).map((s) => ({
    id: s.id,
    to: s.to,
    at: s.at,
    ack: outboundAcks.get(s.id) || null,
  }));
}
let lastAgentRequestAt = 0;
let lastAgentStartedAt = 0;
let lastAgentReplyAt = 0;
let lastAgentError = "";
let agentStderrTail = "";
// Last turn's timing breakdown from the Python agent (no message text).
let lastAgentTrace = null;
// The first successful link already archives the session. Every reconnect
// also reaches handleReady(), so without this guard each 428 would queue
// another full backup and flood the log with "session backed up".
let immediateBackupScheduled = false;
function maskPhone(value) {
  const p = barePhone(value);
  return p ? "***" + p.slice(-4) : "";
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// A plain Promise.race leaves the losing timer running, which keeps a Node test
// process (and any short-lived script) alive for minutes. This clears it.
async function withTimeout(promise, ms, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let pythonBinCache = null;
let pythonBinResolved = false;
function pythonBinCandidates() {
  const candidates = [];
  if (process.env.LIAM_PYTHON) candidates.push(process.env.LIAM_PYTHON);
  candidates.push("python3", "python");
  return candidates;
}
function pythonBin() {
  // Synchronous callers (the agent spawner and probes) must never block the
  // event loop on a child process. Boot starts the async probe; until it finishes
  // this returns a safe platform default.
  if (!pythonBinCache) pythonBinCache = process.platform === "win32" ? "python" : "python3";
  return pythonBinCache;
}
function resolvePythonBinAsync() {
  if (pythonBinResolved) return Promise.resolve(pythonBinCache || pythonBin());
  const candidates = pythonBinCandidates();
  let index = 0;
  return new Promise((resolve) => {
    const tryNext = () => {
      if (index >= candidates.length) {
        pythonBinResolved = true;
        pythonBinCache = pythonBin();
        return resolve(pythonBinCache);
      }
      const bin = candidates[index++];
      let proc;
      try {
        proc = spawn(bin, ["-c", "import sys;print(sys.executable)"], {
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch (e) { return tryNext(); }
      let done = false;
      let out = "";
      const finish = (found) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (found) {
          pythonBinResolved = true;
          pythonBinCache = bin;
          return resolve(bin);
        }
        tryNext();
      };
      const timer = setTimeout(() => {
        try { proc.kill(); } catch (e) {}
        finish(false);
      }, 8000);
      if (typeof timer.unref === "function") timer.unref();
      proc.stdout.on("data", (d) => { out += String(d); });
      proc.on("error", () => finish(false));
      proc.on("close", (code) => finish(code === 0 && !!out.trim()));
    };
    tryNext();
  });
}

// Run debug_probe.py and parse its JSON. Used by /diag?probe=brains so we can
// check each provider key on the machine that actually holds the real keys.
function runProbeScript(args, timeoutMs) {
  return new Promise((resolve) => {
    // Tests drive the HTTP surface without spawning Python.
    if (String(process.env.LIAM_DISABLE_AGENT || "") === "1") {
      return resolve({ error: "disabled in tests" });
    }
    let bin;
    try { bin = pythonBin(); }
    catch (e) { return resolve({ error: "no python: " + String(e) }); }
    let proc;
    try {
      proc = spawn(bin, ["-X", "utf8", "debug_probe.py", ...args], {
        cwd: BASE_DIR,
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
               LIAM_OWNER_TOKEN: OWNER_TOKEN },
      });
    } catch (e) { return resolve({ error: String(e) }); }
    let out = "", err = "";
    let done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      finish({ error: "probe timed out", stderr: err.slice(-400) });
    }, timeoutMs);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("error", (e) => { clearTimeout(timer); finish({ error: String(e) }); });
    proc.on("close", () => {
      clearTimeout(timer);
      try { finish({ json: JSON.parse(out) }); }
      catch (e) {
        finish({ error: "unparseable output",
                 stderr: err.slice(-400), stdout: out.slice(-400) });
      }
    });
  });
}

function startAgent() {
  // Tests drive the HTTP surface without spawning Python.
  if (String(process.env.LIAM_DISABLE_AGENT || "") === "1") return null;
  // Offline is a deliberate state, not a crash. Only an explicit power-on
  // clears it, so nothing (startup, watchdog, deploy) quietly overrides it.
  if (agentOffline) return null;
  if (agentProc && agentProc.exitCode === null && !agentProc.killed) return agentProc;
  let bin;
  try { bin = pythonBin(); }
  catch (e) { console.log("💀 cannot find Python:", String(e)); return null; }
  try {
    agentProc = spawn(bin, ["-X", "utf8", "agent.py"], {
    cwd: BASE_DIR,
    env: {
      ...process.env,
      PYTHONUTF8: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      LIAM_DATA_DIR: DATA_DIR,
      LIAM_OWNER_TOKEN: OWNER_TOKEN,
    },
    stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (e) {
    agentProc = null;
    console.log("💀 AGENT SPAWN ERROR:", String(e));
    return null;
  }
  const proc = agentProc;
  let buf = "";

  const failPending = (err) => {
    if (!agentPending) return;
    const p = agentPending; agentPending = null;
    try { clearTimeout(p.timeout); } catch (e) {}
    p.reject(err);
  };

  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.log("[agent]", line); continue; }
      if (!msg || typeof msg !== "object") continue;
      if (msg.error) {
        lastAgentError = String(msg.error).slice(0, 400);
        console.log("\n💀 AGENT ERROR:", msg.error);
        failPending(new Error(msg.error));
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(msg, "progress")) {
        // Ignore a progress frame that belongs to an older turn. An id is only
        // present on agents that support request gating; an id-less frame is
        // accepted for backward compatibility.
        if (msg.id != null && (!agentPending || String(msg.id) !== String(agentPending.id))) continue;
        // An interim update from the agent. Post it to the chat where the task
        // was given so the person hears progress without re-triggering Liam.
        deliverProgress(msg.progress, agentPending && agentPending.progress)
          .catch((e) => {
            console.log("warn: progress update failed:",
              String(e && e.message ? e.message : e).slice(0, 160));
          });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(msg, "reply")) {
        if (!agentPending) { console.log("[agent] stale reply ignored"); continue; }
        const p = agentPending; agentPending = null;
        try { clearTimeout(p.timeout); } catch (e) {}
        lastAgentReplyAt = Date.now();
        lastAgentError = "";
        if (msg.trace && typeof msg.trace === "object") lastAgentTrace = msg.trace;
        p.resolve(msg.reply == null ? "" : String(msg.reply));
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    const text = String(chunk);
    // Keep the tail for /diag and still forward it to Render's log stream.
    agentStderrTail = (agentStderrTail + text).slice(-4000);
    try { process.stderr.write(text); } catch (e) {}
  });
  proc.stdin.on("error", failPending);
  proc.on("exit", (code, signal) => {
    if (agentProc === proc) agentProc = null;
    failPending(new Error(`agent exited (${code ?? signal ?? "unknown"})`));
    if (!proc.__liamStopping) scheduleAgentRestart();
  });
  proc.on("error", (e) => {
    if (agentProc === proc) agentProc = null;
    console.log("\n💀 AGENT SPAWN ERROR:", String(e));
    failPending(e);
    if (!proc.__liamStopping) scheduleAgentRestart();
  });
  return proc;
}

let agentRestartTimer = null;
function scheduleAgentRestart() {
  // A crash must not make /ready fail just because the child died. WhatsApp is
  // still healthy here, so bring the assistant back without recycling the whole
  // container (which would drop the socket and held state).
  if (agentOffline || agentRestartTimer || shuttingDown || waState !== "ready") return;
  agentRestartTimer = setTimeout(() => {
    agentRestartTimer = null;
    if (agentOffline || shuttingDown || waState !== "ready" || agentProc) return;
    console.log("warn: restarting the agent process after an unexpected exit");
    startAgent();
  }, 1000);
  if (typeof agentRestartTimer.unref === "function") agentRestartTimer.unref();
}

function stopAgent() {
  const proc = agentProc;
  agentProc = null;
  if (agentPending) { const p = agentPending; agentPending = null; try { clearTimeout(p.timeout); } catch (e) {} p.reject(new Error("agent stopped")); }
  if (!proc) return;
  proc.__liamStopping = true;
  if (agentRestartTimer) { try { clearTimeout(agentRestartTimer); } catch (e) {} agentRestartTimer = null; }
  try { proc.stdin.end(); } catch (e) {}
  if (process.platform === "win32" && proc.pid) {
    try { spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" }); return; } catch (e) {}
  }
  try { proc.kill(); } catch (e) {}
}

const LID_MAP_FILE = path.join(DATA_DIR, "lid_map.json");
let lidCache = new Map();
try { const raw = JSON.parse(fs.readFileSync(LID_MAP_FILE, "utf8")); for (const [k,v] of Object.entries(raw)) lidCache.set(k,v); } catch (e) {}
function saveLidMap() {
  try { writeFileAtomic(LID_MAP_FILE, JSON.stringify(Object.fromEntries(lidCache))); } catch (e) {}
}

// WhatsApp now hides phone numbers behind LIDs in many chats. Permissions are
// keyed by phone number, so keep the LID -> phone mapping learned from contact
// updates and group metadata.
const lidContacts = new Map();
const lidSources = new Map();

function isLidJid(value) { return String(value || "").includes("@lid"); }
function barePhone(value) {
  const raw = String(value || "");
  if (!raw || isLidJid(raw)) return "";
  const phone = bareId(raw);
  return /^\d{6,20}$/.test(phone) ? phone : "";
}

function rememberLidContacts(contacts) {
  if (!Array.isArray(contacts)) return;
  let changed = false;
  for (const contact of contacts) {
    if (!contact) continue;
    // A contact carries the phone number in `jid` (or `id`) and the anonymous
    // identity in `lid`/`id`. Prefer whichever field actually holds a phone
    // number, because `id` is often the LID these days.
    const phone = barePhone(contact.jid) || barePhone(contact.phoneNumber)
      || barePhone(contact.id);
    const lid = String(contact.lid || (isLidJid(contact.id) ? contact.id : ""));
    if (!isLidJid(lid) || !phone) continue;
    if (rememberLidMapping(lid, phone, "contact")) changed = true;
  }
  if (changed) saveLidMap();
}

// A mapping learned from a weaker source must be allowed to change when a
// stronger one (a message key or a contact update) says otherwise. Without a
// rank, one stale lookup pinned that person to the wrong identity forever.
const LID_SOURCE_RANK = { state: -1, lookup: 0, signal: 1, group: 2, contact: 3, key: 4 };
function rememberLidMapping(lid, phone, source) {
  const base = bareId(lid);
  const p = barePhone(phone);
  if (!base || !p) return false;
  const prior = lidSources.get(base);
  const rank = LID_SOURCE_RANK[source] === undefined ? 0 : LID_SOURCE_RANK[source];
  const priorRank = prior && LID_SOURCE_RANK[prior] !== undefined ? LID_SOURCE_RANK[prior] : -1;
  if (prior && priorRank > rank) return false;
  if (lidCache.get(base) === p && lidContacts.get(base) === p && prior === source) return false;
  lidContacts.set(base, p);
  lidCache.set(base, p);
  lidSources.set(base, source);
  saveLidMap();
  return true;
}

// Group participants carry both identities. Prefer the phone-number one. In
// Baileys the phone number is `jid`/`phoneNumber`; `id` and `lid` may both be
// the anonymous LID, so they are tried last.
function pnFromParticipant(participant) {
  if (!participant) return "";
  for (const candidate of [participant.jid, participant.phoneNumber,
                           participant.id, participant.lid]) {
    const value = candidate && typeof candidate === "object"
      ? (candidate.id || candidate._serialized || candidate.user || "")
      : candidate;
    const phone = barePhone(value);
    if (phone) return phone;
  }
  return "";
}

function socketSelfIds() {
  const ids = new Set();
  try {
    if (sock && sock.user) {
      for (const value of [sock.user.id, sock.user.lid, sock.user.jid]) {
        const bare = bareId(value);
        if (bare) ids.add(bare);
      }
    }
  } catch (e) {}
  return [...ids];
}

function socketUserId() {
  try { return sock && sock.user ? String(sock.user.id || sock.user.jid || "") : ""; } catch (e) { return ""; }
}

// A burst of messages from one new LID must not start several independent
// network lookups. Coalesce them onto one promise, keyed by the bare LID, and
// drop it once it settles so a later (possibly successful) retry can happen.
const lidResolutions = new Map();

async function resolvePhone(id, message) {
  const raw = String(id || "");
  if (!raw) return null;
  if (!isLidJid(raw)) return barePhone(raw) || null;
  const base = bareId(raw);
  const key = message && message.key ? message.key : {};

  // The key alias is the strongest evidence. It can override a stale mapping
  // learned from a weaker source (group, signal, lookup or directory).
  for (const candidate of [key.participantAlt, key.participantPn, key.senderPn, key.remoteJidAlt]) {
    const phone = barePhone(candidate);
    if (phone) {
      rememberLidMapping(base, phone, "key");
      return phone;
    }
  }
  if (lidCache.has(base)) return lidCache.get(base);
  if (lidContacts.has(base)) {
    const phone = lidContacts.get(base);
    lidCache.set(base, phone);
    saveLidMap();
    return phone;
  }

  // Only the slow, network-backed path is deduplicated above. Every caller that
  // arrives while it is in flight shares the single result.
  if (lidResolutions.has(base)) return lidResolutions.get(base);
  const pending = resolvePhoneRemote(base, raw, key).finally(() => {
    lidResolutions.delete(base);
  });
  lidResolutions.set(base, pending);
  return pending;
}

async function resolvePhoneRemote(base, raw, key) {
  // Group metadata pairs each LID with its phone-number JID.
  const chatJid = key.remoteJid || "";
  if (chatJid && isJidGroup(chatJid) && sock) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      for (const participant of (meta && meta.participants) || []) {
        const lid = participant && participant.lid ? bareId(participant.lid) : "";
        const phone = pnFromParticipant(participant);
        if (!phone) continue;
        if (lid === base || bareId(participant.id) === base
            || bareId(participant.jid) === base || phone === base) {
          if (rememberLidMapping(base, phone, "group")) return phone;
          return lidCache.get(base) || phone;
        }
      }
    } catch (e) {}
  }

  // Newer Baileys builds keep a LID mapping in the signal repository.
  try {
    const mapping = sock && sock.signalRepository && sock.signalRepository.lidMapping;
    if (mapping && typeof mapping.getPNForLID === "function") {
      const result = await mapping.getPNForLID(raw);
      const phone = barePhone(result && (result.id || result.phoneNumber || result));
      if (phone) {
        if (rememberLidMapping(base, phone, "signal")) return phone;
        return lidCache.get(base) || phone;
      }
    }
  } catch (e) {}

  // Last resort: ask WhatsApp about this identity.
  try {
    const list = sock && await sock.onWhatsApp(raw);
    if (Array.isArray(list)) {
      for (const hit of list) {
        const phone = barePhone(hit && (hit.jid || hit.pn || hit.phoneNumber));
        if (phone) {
          if (rememberLidMapping(base, phone, "lookup")) return phone;
          return lidCache.get(base) || phone;
        }
      }
    }
  } catch (e) { console.log("🔍 LID lookup failed:", String(e && e.message ? e.message : e)); }
  console.log("warn: could not map a LID sender to a phone number:", base);
  return null;
}

// ---------------------------------------------------------------------------
// Thin adapter so the rest of the bridge does not care that Baileys replaced
// whatsapp-web.js. Targets are phone-number JIDs; group, LID, broadcast and
// newsletter JIDs are already complete addresses and pass through unchanged.
// ---------------------------------------------------------------------------
function isNewsletterJid(value) {
  return /@newsletter(?::|$)/i.test(String(value || ""));
}
function jidForSend(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("missing recipient");
  if (/@(?:g\.us|lid|broadcast|s\.whatsapp\.net)$/i.test(raw) || isNewsletterJid(raw)) return raw;
  if (/@c\.us$/i.test(raw)) return raw.replace(/@c\.us$/i, "@s.whatsapp.net");
  if (/^\d{6,20}(?::\d+)?$/.test(raw)) return raw.split(":")[0] + "@s.whatsapp.net";
  return raw;
}

// The domain of a JID, without the phone number. Used only by /diag so a
// routing problem (a reply aimed at the wrong kind of address) is visible
// without leaking anyone's number.
function jidType(value) {
  const raw = String(value || "");
  if (raw.endsWith("@g.us")) return "g.us";
  if (raw.endsWith("@lid")) return "lid";
  if (raw.endsWith("@s.whatsapp.net")) return "pn";
  if (raw.endsWith("@broadcast")) return "broadcast";
  if (isNewsletterJid(raw)) return "newsletter";
  return raw ? "other" : "";
}

function messageId(sent) {
  try { return sent && sent.key && sent.key.id ? String(sent.key.id) : null; } catch (e) { return null; }
}

// A socket can be "registered" and still be mid-reconnect: WhatsApp closed the
// old stream (e.g. 440 "conflict" during a deploy) and Baileys has not finished
// the new handshake. A reply written in that window used to throw
// "Connection Closed" and never arrive, even though the agent had already
// produced it. These helpers let a send wait for a live socket and retry once.
function socketUsable() {
  if (!sock) return false;
  const ws = sock.ws;
  // No underlying WebSocket object (only the test stub): the bridge's own
  // ready flag is all we can trust.
  if (!ws) return true;
  try {
    if (ws.isClosed || ws.isClosing) return false;
    if (typeof ws.isOpen === "boolean" && !ws.isOpen) return false;
  } catch (e) { return false; }
  // The WebSocket is open; require the WhatsApp handshake to be complete too.
  return !!registered;
}

function waitForSocketReady(timeoutMs) {
  if (socketUsable()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const tick = () => {
      if (socketUsable()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      const timer = setTimeout(tick, 400);
      if (typeof timer.unref === "function") timer.unref();
    };
    tick();
  });
}

// Errors that mean "the socket went away", not "the message itself is bad".
// Only these are worth retrying once the reconnect finishes. A plain timeout is
// deliberately excluded: it is ambiguous, and retrying could duplicate a message
// that actually reached WhatsApp.
function isConnectionGoneError(message) {
  return /connection closed|not connected|socket closed|stream errored|connection terminated|connection lost|econnreset|closed by remote/i
    .test(String(message || ""));
}

const wa = {
  get connected() { return !!(sock && registered); },
  async sendMessage(jid, content, options) {
    // Baileys requires an object with `text`; unlike whatsapp-web.js it throws
    // "Cannot use 'in' operator to search for 'text'" when given a plain string.
    const payload = typeof content === "string" ? { text: content } : content;
    const target = jidForSend(jid);
    const targetType = jidType(target);
    lastSendTargetType = targetType;
    // While WhatsApp is time-locking the number, every send is refused with 463.
    // Do not spend the reach-out budget on messages that cannot arrive; hold the
    // reply until the lock lifts (re-checked in the background).
    if (reachoutLockActive()) {
      lastSendError = "WhatsApp is temporarily blocking outgoing messages"
        + (reachoutLock.endsAt ? ` until ${reachoutLock.endsAt}` : "");
      const held = new Error(lastSendError);
      held.reachoutLocked = true;
      throw held;
    }
    let lastErr = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const ready = await waitForSocketReady(attempt === 1 ? 15000 : 20000);
      if (!ready) {
        lastErr = new Error("WhatsApp is not connected");
        break;
      }
      try {
        const sent = await sock.sendMessage(target, payload, options);
        lastOutboundAt = Date.now();
        lastSendError = "";
        recordSend(messageId(sent), targetType);
        return sent;
      } catch (e) {
        lastErr = e;
        const msg = String(e && e.message ? e.message : e);
        if (attempt < 2 && isConnectionGoneError(msg)) {
          console.log(`warn: send to ${targetType} failed (${msg.slice(0, 80)}); waiting for reconnect and retrying`);
          continue;
        }
        break;
      }
    }
    lastSendError = String(lastErr && lastErr.message ? lastErr.message : lastErr).slice(0, 300);
    throw lastErr || new Error("WhatsApp is not connected");
  },
  async groupMetadata(jid) {
    if (!sock) throw new Error("WhatsApp is not connected");
    return sock.groupMetadata(jidForSend(jid));
  },
  async leaveGroup(jid) {
    if (!sock) throw new Error("WhatsApp is not connected");
    return sock.groupLeave(jidForSend(jid));
  },
};

// WhatsApp shows "typing..." only while a presence update is kept alive, and a
// blue tick only after readMessages. Sending both the moment we decide to answer
// makes a slow turn feel responsive instead of like dead air.
const typingTimers = new Map();
function markReadAndTyping(jid, msg) {
  const target = jidForSend(jid);
  try {
    if (sock && msg && msg.key && sock.readMessages) {
      Promise.resolve(sock.readMessages([msg.key])).catch(() => {});
    }
  } catch (e) {}
  const ping = () => {
    try {
      if (sock && sock.sendPresenceUpdate) {
        Promise.resolve(sock.sendPresenceUpdate("composing", target)).catch(() => {});
      }
    } catch (e) {}
  };
  ping();
  // Refcount so an interleaved turn (or a progress update) cannot stop the
  // "composing" indicator while another caller still needs it.
  const entry = typingTimers.get(target);
  if (entry) {
    entry.refs += 1;
  } else {
    const timer = setInterval(ping, 10000);
    if (typeof timer.unref === "function") timer.unref();
    typingTimers.set(target, { timer, refs: 1 });
  }
}
function stopTyping(jid) {
  const target = jidForSend(jid);
  const entry = typingTimers.get(target);
  let lastRef = false;
  if (entry) {
    entry.refs -= 1;
    if (entry.refs <= 0) {
      try { clearInterval(entry.timer); } catch (e) {}
      typingTimers.delete(target);
      lastRef = true;
    }
  }
  if (!lastRef) return;
  try {
    if (sock && sock.sendPresenceUpdate) {
      Promise.resolve(sock.sendPresenceUpdate("paused", target)).catch(() => {});
    }
  } catch (e) {}
}
// A held or failed reply must never leave "typing..." running: WhatsApp keeps
// showing it while presence updates arrive, so a forgotten timer looks like an
// agent that is stuck. Called from every failure path.
function stopAllTyping() {
  // Unlike stopTyping() this ignores the refcount: on a failure or close path
  // every indicator must be cleared regardless of how many callers incremented.
  for (const entry of typingTimers.values()) {
    try { clearInterval(entry.timer); } catch (e) {}
  }
  typingTimers.clear();
  try {
    if (sock && sock.sendPresenceUpdate) {
      Promise.resolve(sock.sendPresenceUpdate("paused")).catch(() => {});
    }
  } catch (e) {}
}

function askLiam(user, phone, isGroup, groupJid, mentioned, replyTo, opts = {}) {
  lastAgentRequestAt = Date.now();
  lastAgentError = "";
  const job = () => new Promise((resolve, reject) => {
    lastAgentStartedAt = Date.now();
    const proc = startAgent();
    if (!proc || proc.exitCode !== null || !proc.stdin || proc.stdin.destroyed) {
      return reject(new Error("agent is not running"));
    }
    const id = ++agentRequestId;
    const timeout = setTimeout(() => {
      if (agentPending && agentPending.id === id) {
        agentPending = null;
        stopAgent(); // avoid late replies resolving future requests
        reject(new Error("agent timed out"));
      }
    }, ASK_TIMEOUT_MS);
    agentPending = { resolve, reject, timeout, id, progress: opts.progress || null };
    const payload = JSON.stringify({
      u: String(user == null ? "" : user),
      s: String(phone == null ? "" : phone),
      g: !!isGroup,
      j: groupJid || "",
      m: !!mentioned,
      r: !!replyTo,
      // Echoed on progress frames so a late update from a timed-out turn cannot
      // be delivered under a newer request.
      i: id,
      // A diagnostic probe must not be remembered as a real conversation turn.
      n: !!opts.noHistory
    });
    try { proc.stdin.write(payload + "\n"); }
    catch (e) { clearTimeout(timeout); agentPending = null; stopAgent(); reject(e); }
  });
  const run = agentQueue.then(job, job);
  agentQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Group permissions (3 hours per member per group) and one-time tool approvals
// ---------------------------------------------------------------------------
function sweepTemp(now = Date.now()) {
  let changed = false;
  for (const jid of Object.keys(TEMP)) {
    for (const n of Object.keys(TEMP[jid] || {})) {
      const stamp = TEMP[jid][n];
      if (!stamp || now - Math.abs(stamp) > PERMISSION_TTL_MS) { delete TEMP[jid][n]; changed = true; }
    }
    if (TEMP[jid] && !Object.keys(TEMP[jid]).length) { delete TEMP[jid]; changed = true; }
  }
  for (const [id, p] of pendingPerms) if (!p || now - p.ts > PENDING_TTL_MS) { pendingPerms.delete(id); changed = true; }
  for (const [id, p] of pendingTools) if (!p || now - p.ts > TOOL_APPROVAL_TTL_MS) { pendingTools.delete(id); changed = true; }
  if (changed) scheduleBridgeStateSave();
}
const sweepTimer = setInterval(() => sweepTemp(), 60000);
if (typeof sweepTimer.unref === "function") sweepTimer.unref();

function tempDecision(jid, phone) {
  sweepTemp();
  const p = bareId(phone);
  const entry = jid && TEMP[jid] ? TEMP[jid][p] : null;
  if (!entry) return null;
  return entry > 0 ? "allow" : "deny";
}

// One place for every group-permission mutation, so a grant made through the
// agent tool is persisted just like one made through an approval prompt.
function setGroupPermission(jid, phone, allow, persist = true) {
  const p = bareId(phone);
  if (!jid || !/^\d{6,20}$/.test(p)) return false;
  TEMP[jid] = TEMP[jid] || {};
  TEMP[jid][p] = allow ? Date.now() : -Date.now();
  if (persist) scheduleBridgeStateSave();
  return true;
}

function makeId(prefix) {
  for (let i = 0; i < 20; i += 1) {
    const id = prefix + crypto.randomBytes(3).toString("hex");
    if (!pendingPerms.has(id) && !pendingTools.has(id)) return id;
  }
  return prefix + Date.now().toString(36);
}

function trimPending(map, max = MAX_PENDING) {
  if (map.size <= max) return;
  const entries = [...map.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < entries.length - max; i += 1) map.delete(entries[i][0]);
}

function participantId(participant) {
  if (!participant) return "";
  const id = participant.id || participant;
  if (typeof id === "string") return bareId(id);
  return bareId(id._serialized || id.user || id.id || "");
}

async function ownerIdsInGroup(jid) {
  try {
    const meta = await wa.groupMetadata(jid);
    const parts = Array.isArray(meta && meta.participants) ? meta.participants : [];
    return OWNERS.filter((owner) => parts.some((p) => (
      participantId(p) === owner || pnFromParticipant(p) === owner
    )));
  } catch (e) {
    return [];
  }
}

async function sendApprovalPrompt(text, groupJid) {
  // Group asks normally stay in the group: the owner replies there and everyone
  // can see that Liam is waiting for a yes/no. But when no owner is in the
  // group, a group-only prompt is never seen, so fall back to DMing the owners.
  if (groupJid) {
    const owners = await ownerIdsInGroup(groupJid);
    if (owners.length) {
      const tags = owners.map((o) => "@" + o).join(" ");
      const body = `${tags} ${text}`.trim();
      try {
        await wa.sendMessage(groupJid, body, {
          mentions: owners.map((o) => o + "@s.whatsapp.net"),
        });
        return true;
      } catch (e) {
        console.log("warn: group approval prompt failed:", String(e));
        return false;
      }
    }
    // No owner present in this group. DM them with enough context to act.
    const dmText = `Group approval needed (${groupJid}):\n${text}`;
    let sent = 0;
    for (const owner of OWNERS) {
      try {
        await wa.sendMessage(owner + "@s.whatsapp.net", dmText);
        sent += 1;
      } catch (e) { console.log("warn: owner approval DM failed:", String(e)); }
    }
    return sent > 0;
  }
  let sent = 0;
  for (const owner of OWNERS) {
    try {
      await wa.sendMessage(owner + "@s.whatsapp.net", text);
      sent += 1;
    } catch (e) { console.log("warn: owner approval DM failed:", String(e)); }
  }
  return sent > 0;
}

function toolApprovalText(p) {
  let args = "";
  try { args = JSON.stringify(p.payload, Object.keys(p.payload || {}).sort()); } catch (e) { args = "{}"; }
  if (args.length > 900) args = args.slice(0, 900) + "…";
  return [
    `Owner approval needed (one-time, valid ${humanWindow(TOOL_APPROVAL_TTL_MS)}).`,
    `From: ${p.actor || "unknown"}`,
    `Tool: ${p.action}`,
    `Args: ${args}`,
    `Reply: yes ${p.id} / no ${p.id}`,
  ].join("\n");
}

async function createToolApproval(action, payload, actor, ctx = {}) {
  sweepTemp();
  const id = makeId("t");
  const p = {
    id, action,
    payload: { ...payload, action, sender: actor },
    actor,
    chat: String(ctx.chat || actor || ""),
    isGroup: !!ctx.isGroup,
    ts: Date.now(),
  };
  pendingTools.set(id, p);
  trimPending(pendingTools);
  const sent = await sendApprovalPrompt(toolApprovalText(p), ctx.isGroup ? ctx.chat : "");
  if (!sent) {
    pendingTools.delete(id);
    throw new BadRequest("no owner is reachable for approval");
  }
  scheduleBridgeStateSave();
  return p;
}

function humanWindow(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hours`;
}

function permissionPromptText(p) {
  // Show a short excerpt of what was asked, so the owner approves the same
  // request that was re-prompted instead of an opaque id.
  const excerpt = String(p.text || "").replace(/\s+/g, " ").trim().slice(0, 300);
  return [
    `Group permission needed (${humanWindow(PERMISSION_TTL_MS)}).`,
    `${p.phone} wants Liam to reply in this group.`,
    excerpt ? `They asked: ${excerpt}${String(p.text || "").length > 300 ? "…" : ""}` : "",
    `Request ${p.id}.`,
    `Reply: yes ${p.id} / no ${p.id}`,
  ].filter(Boolean).join("\n");
}

async function createPermissionRequest(jid, phone, text, quoted) {
  sweepTemp();
  const bare = bareId(phone);
  const next = String(text || "").slice(0, 2000);
  for (const p of pendingPerms.values()) {
    if (p.jid === jid && p.phone === bare) {
      const changed = next.trim() !== String(p.promptedText || "").trim();
      // The owner must approve exactly what they can see. If the member's
      // request changed after the prompt went out, re-send it (capped so a
      // chatty member cannot spam the group with prompts). Once the cap is
      // reached, reject the new text and keep the version that was prompted,
      // otherwise the owner would approve one question while Liam answers a
      // different one they never saw.
      if (changed) {
        if ((p.promptCount || 1) < 3) {
          // Build the prompt from a candidate so a failed send cannot make the
          // owner approve text that was silently substituted afterwards.
          const candidate = {
            ...p,
            text: next,
            promptedText: next,
            promptCount: (p.promptCount || 1) + 1,
          };
          const sent = await sendApprovalPrompt(permissionPromptText(candidate), jid);
          if (!sent) throw new BadRequest("I couldn't reach an owner with the changed request, so nothing was approved");
          p.text = next;
          p.promptedText = next;
          p.promptCount = candidate.promptCount;
          p.quoted = quoted || p.quoted;
        } else {
          // The cap is intentional, but silently approving later edits would let
          // a member swap the question after the owner last saw it. Drop this
          // request and make them start a fresh one.
          pendingPerms.delete(p.id);
          scheduleBridgeStateSave();
          const err = new BadRequest("that request was changed too many times; send a fresh request before I can answer");
          err.code = "permission_reprompt_limit";
          throw err;
        }
      }
      p.ts = Date.now();
      scheduleBridgeStateSave();
      return p;
    }
  }
  const id = makeId("p");
  const p = {
    id, jid, phone: bare,
    text: next,
    quoted: quoted || null,
    ts: Date.now(),
    promptedText: next,
    promptCount: 1,
  };
  pendingPerms.set(id, p);
  trimPending(pendingPerms);
  const sent = await sendApprovalPrompt(permissionPromptText(p), jid);
  if (!sent) {
    pendingPerms.delete(id);
    return null;
  }
  scheduleBridgeStateSave();
  return p;
}

async function executeToolApproval(id, ownerChat) {
  const p = pendingTools.get(id);
  if (!p) return "that approval request has expired or was already used";
  pendingTools.delete(id);
  scheduleBridgeStateSave();
  if (Date.now() - p.ts > TOOL_APPROVAL_TTL_MS) return "that approval request has expired";
  try {
    const result = await handleAction({ ...p.payload, approved: true }, { approved: true });
    const text = String(result || "done");
    const target = chatTarget(p.chat || p.actor, p.isGroup);
    await sendLong(target, `✅ Approved ${p.action} — result:\n${text.slice(0, 3500)}`);
    if (ownerChat && ownerChat !== target) {
      try { await wa.sendMessage(ownerChat, `Done — ${p.action} ran.`); } catch (e) {}
    }
    return "approved and executed";
  } catch (e) {
    const message = e instanceof BadRequest ? e.message : "the approved action failed";
    try { await wa.sendMessage(chatTarget(p.chat || p.actor, p.isGroup), `❌ ${p.action} failed: ${message}`); } catch (e2) {}
    return message;
  }
}

async function handleApprovalCommand(text, phone, chat, isGroup) {
  if (!OWNERS.includes(bareId(phone))) return false;
  const match = /^(yes|allow|ok|approve|no|deny|ignore)\b(?:\s+([a-z0-9_-]+))?$/i.exec(String(text || "").trim());
  if (!match) return false;
  const allow = /^(yes|allow|ok|approve)$/i.test(match[1]);
  const wanted = String(match[2] || "").toLowerCase();

  // Tool approvals are always exact: the owner must include the request id.
  // A bare "yes"/"ok" must never approve a shell command, even when only one
  // request is pending.
  let toolId = null;
  if (wanted && pendingTools.has(wanted)) toolId = wanted;
  if (toolId) {
    const p = pendingTools.get(toolId);
    if (allow) {
      await executeToolApproval(toolId, chat);
    } else {
      pendingTools.delete(toolId);
      scheduleBridgeStateSave();
      try { await wa.sendMessage(chat, `🚫 denied ${toolId} (${p ? p.action : "tool"}).`); } catch (e) {}
    }
    return true;
  }

  // A bare "yes" must not silently approve a group permission while a *tool*
  // approval is pending for this same chat (that is why the id is required).
  // A tool approval pending in a different group must not block this one. In a
  // DM the owner answers tool approvals from their own chat, so any pending
  // tool approval is relevant there.
  const toolPendingHere = isGroup
    ? [...pendingTools.values()].some((t) => t.chat === chat)
    : pendingTools.size > 0;

  let permId = null;
  if (wanted && pendingPerms.has(wanted)) permId = wanted;
  else if (!wanted && !toolPendingHere) {
    const list = [...pendingPerms.values()].filter((p) => p.ts && Date.now() - p.ts <= PENDING_TTL_MS);
    // Inside a group only that group's request can be approved; in a DM an
    // owner can approve any request (that's where prompts go when no owner is
    // present in the group).
    const inChat = isGroup ? list.filter((p) => p.jid === chat) : list;
    const pool = inChat.length ? inChat : (isGroup ? [] : list);
    pool.sort((a, b) => b.ts - a.ts);
    if (pool.length === 1) permId = pool[0].id;
    else if (pool.length > 1) {
      try { await wa.sendMessage(chat, "There is more than one request — reply with the id, e.g. `yes p123abc`."); } catch (e) {}
      return true;
    }
  }
  if (permId) {
    const p = pendingPerms.get(permId);
    pendingPerms.delete(permId);
    if (!allow) {
      setGroupPermission(p.jid, p.phone, false);
      try { await wa.sendMessage(p.jid, `okay, I won't reply to ${p.phone} in this group.`); } catch (e) {}
      if (chat !== p.jid) { try { await wa.sendMessage(chat, `okay — denied ${p.id}.`); } catch (e) {} }
      return true;
    }
    setGroupPermission(p.jid, p.phone, true);
    try { await wa.sendMessage(p.jid, `okay, I'll reply to ${p.phone} for the next ${humanWindow(PERMISSION_TTL_MS)}.`); } catch (e) {}
    markReadAndTyping(p.jid, p.quoted);
    try {
      const reply = await askLiam(p.text, p.phone, true, p.jid, true, false,
        { progress: { to: p.jid, isGroup: true, quoted: p.quoted } });
      const sent = await sendLong(p.jid, reply, p.quoted ? { quoted: p.quoted } : undefined);
      rememberLiamMessage(p.jid, messageId(sent));
    } catch (e) {
      console.log("warn: approved reply failed:", String(e));
      try { await sendLong(p.jid, SERVER_DOWN_TEXT, p.quoted ? { quoted: p.quoted } : undefined); } catch (e2) {}
    }
    stopTyping(p.jid);
    if (chat !== p.jid) { try { await wa.sendMessage(chat, `okay — allowed ${p.phone} for ${humanWindow(PERMISSION_TTL_MS)}.`); } catch (e) {} }
    return true;
  }

  if (wanted) {
    const prefix = wanted[0];
    if (prefix === "t" || prefix === "p") {
      try { await wa.sendMessage(chat, `I don't see ${wanted} — it expired or was already used.`); } catch (e) {}
      return true;
    }
  }
  if (!wanted && toolPendingHere) {
    try {
      await wa.sendMessage(chat, "Tool approvals need the request id — reply `yes t…` or `no t…`.");
    } catch (e) {}
    return true;
  }
  return false;
}

// Baileys logs every protocol frame at debug level. On Render's free log plan
// that is noise, so by default drop everything and print only the events Liam
// cares about. LIAM_WA_LOG (or /diag&walog=) can raise it temporarily when a
// protocol-level bug has to be seen.
const WA_LOG_ORDER = ["trace", "debug", "info", "warn", "error", "fatal"];
const WA_LOG_ONCE_MS = 5 * 60 * 1000;
let waLogLevel = String(process.env.LIAM_WA_LOG || "silent").toLowerCase();
let waLogResetTimer = null;
function waLogEnabled(name) {
  const idx = WA_LOG_ORDER.indexOf(waLogLevel);
  return idx >= 0 && WA_LOG_ORDER.indexOf(name) >= idx;
}
function baileysLogger() {
  const emit = (name) => (...args) => {
    if (!waLogEnabled(name)) return;
    try { console.log(`[wa:${name}]`, args.length === 1 ? args[0] : args); } catch (e) {}
  };
  const logger = {
    get level() { return WA_LOG_ORDER.indexOf(waLogLevel) >= 0 ? waLogLevel : "silent"; },
    trace: emit("trace"), debug: emit("debug"), info: emit("info"),
    warn: emit("warn"), error: emit("error"), fatal: emit("fatal"),
  };
  logger.child = () => logger;
  return logger;
}

function closeStatusCode(lastDisconnect) {
  const error = lastDisconnect && lastDisconnect.error;
  if (!error) return 0;
  const output = error.output || {};
  return Number(output.statusCode) || Number(error.statusCode) || 0;
}

function socketIsRegistered() {
  try {
    const creds = sock && sock.authState && sock.authState.creds;
    return !!(creds && creds.registered);
  } catch (e) { return false; }
}

function handleReady() {
  if (readyHandled) return;
  readyHandled = true;
  registered = true;
  sockReadyForPairing = false;
  waLastQrAt = 0;
  reconnectDelayMs = 3000;
  closeCount = 0;
  closeWindowStart = 0;
  pairingError = "";
  noteWaEvent("ready");
  console.log("\n🚀 LIAM IS LIVE — waiting for messages...\n");
  removeQrFile();
  setWaState("ready", "WhatsApp connected");
  // Remember that this profile is a real, completed login. Boot wipes any
  // profile without this marker so a half-finished link cannot poison the next
  // attempt.
  markLinked({ wid: socketUserId() || "linked" });
  startAgent();
  // A reconnect can be the first moment the block has lifted. Do not make a
  // held answer wait for the next 5-minute timer or probe.
  void flushHeldReplies();
  // Start backups only after WhatsApp is actually linked. Before this point
  // the profile is disposable and must never replace a good cloud copy.
  sync.startPeriodicBackup(DATA_DIR, SESSION_DIR, DATA_DIR);
  // Archive immediately, so a free Render instance that spins down soon after
  // pairing still leaves a restorable session in Supabase. Only once per
  // process: reconnects re-enter this function and must not re-archive.
  if (!immediateBackupScheduled) {
    immediateBackupScheduled = true;
    const backupTimer = setTimeout(() => {
      try {
        Promise.resolve(sync.backupNow(DATA_DIR, SESSION_DIR, DATA_DIR))
          .then((r) => { if (!r || !r.ok) console.log("warn: immediate backup did not complete"); })
          .catch((e) => console.log("warn: immediate backup failed:", String(e)));
      } catch (e) {}
    }, 3000);
    if (typeof backupTimer.unref === "function") backupTimer.unref();
  }
}

function scheduleReconnect(reason, delay) {
  if (reconnectTimer || resetInFlight) return;
  const wait = Math.max(500, Number.isFinite(delay) ? delay : reconnectDelayMs);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (waState === "ready") return;
    if (resetInFlight) return;
    noteWaEvent("reconnect", `${reason} (after ${wait} ms)`);
    try {
      await initializeWhatsApp(`reconnect: ${reason}`);
    } catch (e) {
      console.log("warn: reconnect failed:", String(e).split("\n")[0]);
    }
  }, wait);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
  reconnectDelayMs = Math.min(60000, Math.max(3000, reconnectDelayMs * 2));
}

function handleConnectionClose(socket, status, detail) {
  if (socket !== sock) return;
  stopAllTyping();
  sockReadyForPairing = false;
  registered = false;
  readyHandled = false;
  const reason = String(detail || "").split("\n")[0].slice(0, 200);
  noteWaEvent("closed", `${status || "?"} ${reason}`);
  console.log(`\n⚠️ WhatsApp connection closed (${status || "unknown"})${reason ? ": " + reason : ""}`);
  // Do not kill the Python agent on a transient socket drop. The turn can
  // finish; wa.sendMessage() already waits for the reconnect and holds the
  // reply if the socket never comes back. Killing here is what made a 428
  // look like Liam abandoning a task and forgetting it on the next message.
  if (status === DisconnectReason.loggedOut) {
    // The phone removed this device. The stored profile is dead, so start over
    // with a clean one instead of reconnecting with dead credentials.
    clearLinkMarker();
    setWaState("error", "the phone removed this device; link it again");
    resetWhatsApp("the phone removed this device").catch((e) => console.log("warn: reset after logout failed:", String(e)));
    return;
  }

  if (status === DisconnectReason.restartRequired) {
    // This is the normal end of a successful 8-character code login: WhatsApp
    // closes the socket once and wants an immediate reconnect with the new
    // credentials. Never wipe anything here.
    setWaState("linking", "code accepted - finishing login");
    noteWaEvent("restart_required", "reconnecting with the new credentials");
    scheduleReconnect("restart required", 1000);
    return;
  }

  const rateLimited = status === 429 || /rate[- ]?overlimit|too many|429/i.test(reason);
  if (rateLimited) {
    setWaState("disconnected", `WhatsApp is limiting this number; waiting ${humanWindow(RATE_LIMIT_COOLDOWN_MS)}`);
    noteWaEvent("rate_limited", reason);
    scheduleReconnect("rate limited", RATE_LIMIT_COOLDOWN_MS);
    return;
  }

  const now = Date.now();
  if (!closeWindowStart || now - closeWindowStart > 5 * 60 * 1000) {
    closeWindowStart = now;
    closeCount = 0;
  }
  closeCount += 1;
  if (closeCount > 3) {
    // A burst of transient server-side closes (e.g. "428 Connection Terminated
    // by Server") must not destroy a linked login. Wiping it here forced a full
    // re-pair for a hiccup a plain reconnect would have fixed. Only recycle the
    // socket and keep the saved credentials; wipe only when never linked.
    if (hasLinkMarker() && profileHasCredentials()) {
      setWaState("disconnected", "WhatsApp keeps disconnecting; reconnecting with the saved login");
      noteWaEvent("reconnect_loop", "repeated disconnects (login kept)");
      resetWhatsApp("WhatsApp keeps disconnecting", { wipe: false })
        .catch((e) => console.log("warn: auto reset failed:", String(e)));
    } else {
      setWaState("error", "WhatsApp keeps disconnecting");
      autoReset("WhatsApp keeps disconnecting");
    }
    return;
  }
  setWaState("disconnected", "connection dropped; reconnecting");
  scheduleReconnect(`closed (${status || "unknown"})`, reconnectDelayMs);
}

function onConnectionUpdate(socket, update) {
  if (socket !== sock) return;
  const { connection, lastDisconnect, qr } = update || {};
  if (qr) {
    if (socketIsRegistered()) {
      // After a code login WhatsApp can emit one last QR while credentials are
      // already registered. Showing "scan me" there would look like a failure.
      noteWaEvent("qr_ignored", "credentials are already registered");
    } else if (waState === "linking" && linkHandshakeActive()) {
      // Baileys keeps rotating QR refs until they run out, even after a pairing
      // code was requested. Do not let that reset the UI to needs_qr while the
      // phone is still typing the code.
      noteWaEvent("qr_ignored", "pairing code handshake in progress");
    } else {
      sockReadyForPairing = true;
      waLastQrAt = Date.now();
      noteWaEvent("qr_ready");
      if (waState !== "ready" && waState !== "linking") {
        setWaState("needs_qr", "ready to link - open the pairing page");
        console.log("\n📱 READY TO PAIR — open the pairing page and press the button.");
      }
    }
  }
  if (connection === "open") {
    sockReadyForPairing = false;
    authAt = Date.now();
    noteWaEvent("open");
    handleReady();
    void refreshReachoutLock();
    return;
  }
  if (connection === "close") {
    const error = lastDisconnect && lastDisconnect.error;
    handleConnectionClose(socket, closeStatusCode(lastDisconnect), error && error.message);
  }
}

async function closeSocket(reason) {
  if (reconnectTimer) {
    try { clearTimeout(reconnectTimer); } catch (e) {}
    reconnectTimer = null;
  }
  const current = sock;
  if (!current) return;
  stopAllTyping();
  try { current.ev.removeAllListeners("connection.update"); } catch (e) {}
  try { current.ev.removeAllListeners("creds.update"); } catch (e) {}
  try { current.end(new Error(reason || "closing")); } catch (e) {}
  // Give the websocket a moment to send the close frame; it is not required for
  // correctness, but avoids reconnecting while the old socket is still open.
  await sleep(150);
  // Clear the global last, so teardown events cannot fire handlers that read a
  // null socket while closing the previous one.
  if (sock === current) sock = null;
  connecting = false;
  sockReadyForPairing = false;
  registered = false;
}

async function connectSocket(reason) {
  if (connecting) return sock;
  connecting = true;
  try {
    await closeSocket(reason);
    if (!waVersion) {
      try {
        const info = await fetchLatestBaileysVersion();
        waVersion = Array.isArray(info && info.version) ? info.version : null;
        if (waVersion) console.log("info: WhatsApp Web version", waVersion.join("."));
      } catch (e) {
        waVersion = null;
        console.log("warn: could not fetch the WhatsApp Web version; using the bundled default");
      }
    }
    fs.mkdirSync(SESSION_PROFILE_DIR, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PROFILE_DIR);
    const socket = makeWASocket({
      version: waVersion || undefined,
      logger: baileysLogger(),
      printQRInTerminal: false,
      browser: Browsers.ubuntu("Chrome"),
      auth: state,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      // Keep each QR ref alive for a minute. Baileys closes the socket with 408
      // after the server's refs run out; a longer interval leaves more headroom
      // for the phone to finish typing an 8-character code.
      qrTimeout: 60000,
      // Receipts and decryption retries ask for the original message. Liam
      // stores nothing, so returning undefined is the honest answer.
      getMessage: async () => undefined,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: WA_KEEPALIVE_MS,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
    });
    sock = socket;
    readyHandled = false;
    registered = false;
    sockReadyForPairing = false;
    watchSocketWire(socket);
    socket.ev.on("creds.update", () => {
      // Baileys emits this without awaiting. A failed write must not become an
      // unhandled rejection that takes the whole bridge down.
      Promise.resolve(saveCreds()).catch((e) => {
        console.log("warn: could not save WhatsApp credentials:", String(e && e.message ? e.message : e).slice(0, 200));
      });
    });
    socket.ev.on("connection.update", (update) => onConnectionUpdate(socket, update));
    socket.ev.on("messages.upsert", (event) => {
      if (!event || event.type !== "notify" || !Array.isArray(event.messages)) return;
      for (const message of event.messages) handleIncomingMessage(message);
    });
    // Delivery acknowledgements for our own outbound messages, so a reply that
    // WhatsApp accepts but never delivers is visible instead of silent.
    socket.ev.on("messages.update", (updates) => {
      messagesUpdateCount += 1;
      try { recordAcks(updates); } catch (e) {}
    });
    socket.ev.on("message-receipt.update", (updates) => {
      receiptUpdateCount += 1;
      try {
        for (const item of Array.isArray(updates) ? updates : []) {
          const id = item && item.key && item.key.id;
          if (!id) continue;
          const receipt = (item && item.receipt) || {};
          const status = receipt.readTimestamp || receipt.playedTimestamp ? 4 : 3;
          recordAcks([{ key: item.key, update: { status } }]);
        }
      } catch (e) {}
    });
    // Contact events carry the LID -> phone mapping permissions depend on.
    const remember = (list) => { try { rememberLidContacts(list); } catch (e) {} };
    socket.ev.on("contacts.upsert", remember);
    socket.ev.on("contacts.update", remember);
    console.log(`info: WhatsApp socket opened (${reason || "startup"})`);
    return socket;
  } finally {
    connecting = false;
  }
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------
function isNameMention(text) {
  const value = String(text || "");
  // Only treat "Liam" as a trigger when the message actually addresses her.
  // This deliberately avoids replying to every sentence that mentions a Liam.
  return /^\s*@?liam\b/i.test(value) ||
    /\b(?:hey|hi|hello|yo|ok|okay|please|pls|babe|baby)\s+liam\b/i.test(value) ||
    /\bliam\s*[,:!?]/i.test(value);
}

function chatTarget(value, isGroup) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  if (isGroup || raw.endsWith("@g.us") || raw.endsWith("@s.whatsapp.net") || raw.endsWith("@lid")) return raw;
  return raw + "@s.whatsapp.net";
}

function splitMessage(text, limit = 4000) {
  const value = String(text == null ? "" : text);
  if (value.length <= limit) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function sendLong(to, text, options, onChunk, resumeFromChunks = 0) {
  let last = null;
  const chunks = splitMessage(text);
  const start = Math.max(0, Math.min(chunks.length, Number(resumeFromChunks) || 0));
  for (let i = start; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (!chunk.trim()) continue;
    const sendOptions = start === 0 && i === 0 ? options : undefined;
    last = await wa.sendMessage(to, chunk, sendOptions);
    if (typeof onChunk === "function") onChunk(i + 1);
  }
  return last;
}

// An interim progress update from the agent. It goes to the chat where the task
// was given: quoted in a group (so it threads under the triggering message) and
// plain in a DM. A group progress message is remembered as a Liam message, so a
// reply to it still counts as addressing Liam.
function deliverProgress(text, where) {
  const body = String(text == null ? "" : text).slice(0, 2000).trim();
  if (!body || !where || !where.to) return Promise.resolve(null);
  const options = (where.isGroup && where.quoted) ? { quoted: where.quoted } : undefined;
  return sendLong(where.to, body, options).then((sent) => {
    if (where.isGroup) rememberLiamMessage(where.to, messageId(sent));
    return sent;
  });
}

const recentMessageIds = new Set();
function seenMessage(id) {
  if (!id) return false;
  if (recentMessageIds.has(id)) return true;
  recentMessageIds.add(id);
  if (recentMessageIds.size > 500) {
    const oldest = recentMessageIds.values().next().value;
    recentMessageIds.delete(oldest);
  }
  return false;
}

const TEXT_MESSAGE_TYPES = new Set([
  "conversation", "extendedTextMessage", "buttonsResponseMessage",
  "listResponseMessage", "templateButtonReplyMessage", "buttonsMessage",
  "listMessage", "contactMessage", "contactsArrayMessage",
  "pollCreationMessage", "pollResponseMessage",
]);
function messageText(content, type) {
  const part = content && content[type];
  if (!part) return "";
  switch (type) {
    case "conversation": return String(content.conversation || "");
    case "extendedTextMessage":
    case "buttonsMessage": return String(part.text || "");
    case "imageMessage":
    case "videoMessage":
    case "documentMessage": return String(part.caption || "");
    case "buttonsResponseMessage": return String(part.selectedButtonId || part.selectedDisplayText || "");
    case "listResponseMessage": return String(part.title || (part.singleSelectReply && part.singleSelectReply.selectedRowId) || "");
    case "templateButtonReplyMessage": return String(part.selectedDisplayText || part.selectedId || "");
    case "listMessage": return String(part.description || part.title || "");
    case "contactMessage": return String(part.displayName || part.name || "");
    case "contactsArrayMessage": return String((Array.isArray(part.contacts) ? part.contacts : [])
      .map((c) => c && (c.displayName || c.name)).filter(Boolean).join(", "));
    case "pollCreationMessage": return String(part.name || part.question || "");
    case "pollResponseMessage": return String((Array.isArray(part.selectedOptions) ? part.selectedOptions : [])
      .map((o) => o && (o.optionName || o.name)).filter(Boolean).join(", "));
    default: return "";
  }
}

// Media Liam cannot read yet. Without a caption these used to be dropped
// silently, so she looked dead. A clear placeholder keeps the normal addressing
// and permission flow and lets her answer honestly (see the system prompt).
function mediaPlaceholder(content, type) {
  const part = content && content[type];
  if (!part || TEXT_MESSAGE_TYPES.has(type)) return "";
  switch (type) {
    case "audioMessage": return "[sent a voice note]";
    case "imageMessage": return "[sent an image]";
    case "videoMessage": return "[sent a video]";
    case "documentMessage": return "[sent a document]";
    case "stickerMessage": return "[sent a sticker]";
    default: {
      const label = String(type || "message")
        .replace(/Message$/i, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .toLowerCase() || "message";
      return `[sent a ${label}]`;
    }
  }
}

// Captioned media must not lose the fact that something was attached, and a
// message type with no readable text still needs a clear placeholder.
function displayText(content, type) {
  const text = messageText(content, type);
  const placeholder = mediaPlaceholder(content, type);
  if (text && placeholder) return `${placeholder}: ${text}`;
  return text || placeholder;
}

function contentContext(content, type) {
  try {
    const part = content && content[type];
    return (part && part.contextInfo) || {};
  } catch (e) { return {}; }
}

async function handleIncomingMessage(msg) {
  try {
    if (!msg || !msg.message || !msg.key) return;
    const key = msg.key;
    if (key.fromMe) return;
    const from = String(key.remoteJid || "");
    if (!from || from === "status@broadcast" || from.endsWith("@broadcast") || from.endsWith("@newsletter")) return;
    if (seenMessage(key.id)) return;
    inboundCount += 1;
    lastInboundAt = Date.now();
    lastInboundKind = from.endsWith("@g.us") ? "group" : "dm";
    lastInboundError = "";
    lastInboundFromType = jidType(from);

    const content = normalizeMessageContent(msg.message);
    if (!content) return;
    const type = getContentType(content);
    if (!type || type === "protocolMessage" || type === "reactionMessage" ||
        type === "senderKeyDistributionMessage" || type === "messageContextInfo") return;
    const text = displayText(content, type);
    if (!text) return;

    const isGroup = isJidGroup(from) || from.endsWith("@g.us");
    const senderId = isGroup
      ? (key.participantAlt || key.participantPn || key.senderPn || key.participant || from)
      : (key.remoteJidAlt || key.senderPn || from);
    let phone = await resolvePhone(senderId, msg);
    let lidOnly = false;
    if (!phone) {
      // We could not map this sender to a phone number, only a LID. Dropping
      // them makes Liam look dead, so fall back to the LID as their identity:
      // a group request can still be approved, and a DM is answered at the LID.
      const fallback = bareId(senderId);
      if (isJidGroup(senderId) || isJidGroup(from) || /@g\.us/i.test(String(senderId))) {
        lastInboundError = "group sender has no phone identity";
        console.log("warn: ignoring group JID used as a member sender", senderId);
        return;
      }
      if (!/^\d{6,20}$/.test(fallback)) {
        lastInboundError = "could not resolve sender to a phone number";
        console.log("warn: could not resolve sender", senderId);
        return;
      }
      phone = fallback;
      lidOnly = true;
      console.log("warn: using LID identity for sender", phone);
    }
    lastInboundPhone = phone;

    const context = contentContext(content, type);
    const replyTo = context.stanzaId ? String(context.stanzaId) : null;

    // Owner approval/denial works in a DM or in the group, before any gate.
    if (await handleApprovalCommand(text, phone, from, isGroup)) return;

    if (!isGroup) {
      // A direct message can arrive addressed by an anonymous LID instead of a
      // phone number. Replying to the LID can look like it succeeded while never
      // being delivered; the phone-number JID always delivers, and the number is
      // already resolved for this sender. When only a LID identity is known,
      // reply to the LID itself (a made-up phone JID would not deliver).
      const dmTarget = (!lidOnly && phone) ? `${phone}@s.whatsapp.net` : from;
      // .allowdm: owners + admins + known group members. .disallowdm: owners + admins.
      if (!OWNERS.includes(phone) && (text === ".allowdm" || text === ".disallowdm")) return;
      if (OWNERS.includes(phone) && (text === ".allowdm" || text === ".disallowdm")) {
        setDmOpen(text === ".allowdm");
        const adminNames = Object.values(ADMINS)
          .map((a) => String(a && a.name || "").trim()).filter(Boolean);
        const family = adminNames.length
          ? adminNames.join(", ")
          : `${Object.keys(ADMINS).length} admin${Object.keys(ADMINS).length === 1 ? "" : "s"}`;
        const reply = dmOpen
          ? "okay babe, DMs are open to owners, admins and people I already know from groups"
          : `okay babe, DMs are closed again — only you and ${family} can reach me now`;
        console.log(`\n📩 [toggle] ${phone}\n💬 Liam: ${reply}\n`);
        await sendLong(dmTarget, reply);
        return;
      }
      const allowed = dmAllowed(phone);
      if (!allowed) {
        lastInboundKind = "dm (not allowed)";
        lastInboundError = "sender is not an owner/admin and DMs are closed";
        return;
      }
      markReadAndTyping(dmTarget, msg);
      let reply;
      try {
        reply = await askLiam(text, phone, false, "", false, false,
          { progress: { to: dmTarget, isGroup: false, quoted: null } });
      } catch (e) {
        console.log(`\n💀 agent failed for DM ${phone}: ${String(e)}`);
        try { await sendLong(dmTarget, SERVER_DOWN_TEXT); } catch (e2) {}
        stopTyping(dmTarget);
        return;
      }
      console.log(`\n📩 ${phone}: ${text}\n💬 Liam: ${reply}\n`);
      try {
        const sent = await sendLong(dmTarget, reply);
        console.log(`   ↳ reply accepted by WhatsApp (${jidType(dmTarget)}, id ${messageId(sent) || "?"})`);
      } catch (e) {
        if (e && e.reachoutLocked) holdReply(dmTarget, reply);
        else throw e;
      } finally {
        stopTyping(dmTarget);
      }
      return;
    }

    // Track people Liam has seen in a group; used only by .allowdm.
    if (!OWNERS.includes(phone) && !(phone in ADMINS)) rememberKnownMember(phone);

    const selfIds = socketSelfIds();
    const mentionedIds = Array.isArray(context.mentionedJid) ? context.mentionedJid.map(bareId) : [];
    const mentioned =
      mentionedIds.some((id) => selfIds.includes(id)) ||
      selfIds.some((id) => id && text.includes("@" + id)) ||
      isNameMention(text);
    const replyingToLiam = !!replyTo && isLiamMessage(from, replyTo);
    if (!mentioned && !replyingToLiam) {
      lastInboundKind = "group (not addressed)";
      return;
    }

    let who;
    if (OWNERS.includes(phone)) who = "owner";
    else if (phone in ADMINS) who = "admin";
    else who = "member";

    // Members need a 3-hour permission per group. Owners and admins do not.
    if (who === "member") {
      const decision = tempDecision(from, phone);
      if (decision === "deny") return;
      if (decision !== "allow") {
        let p = null;
        try {
          p = await createPermissionRequest(from, phone, text, msg);
        } catch (e) {
          if (e && e.code === "permission_reprompt_limit") {
            try { await wa.sendMessage(from, String(e.message)); } catch (e2) {}
            return;
          }
          throw e;
        }
        if (!p) {
          try { await wa.sendMessage(from, "I couldn't reach an owner to approve that, so I didn't reply."); } catch (e) {}
          return;
        }
        try {
          await wa.sendMessage(from, `I've asked the owner whether I can reply to ${phone}. (request ${p.id})`);
        } catch (e) {}
        return;
      }
    }

    markReadAndTyping(from, msg);
    let reply;
    try {
      reply = await askLiam(text, phone, true, from, mentioned, replyingToLiam,
        { progress: { to: from, isGroup: true, quoted: msg } });
    } catch (e) {
      console.log(`\n💀 agent failed in group ${from}: ${String(e)}`);
      try { await sendLong(from, SERVER_DOWN_TEXT, { quoted: msg }); } catch (e2) {}
      stopTyping(from);
      return;
    }
    console.log(`\n📩 [${from}] ${who} ${phone}: ${text}\n💬 Liam: ${reply}\n`);
    // In a group, answer the exact message that triggered her with a WhatsApp
    // quoted reply instead of dropping a bare line into the chat.
    try {
      const sent = await sendLong(from, reply, { quoted: msg });
      console.log(`   ↳ reply accepted by WhatsApp (${jidType(from)}, id ${messageId(sent) || "?"})`);
      rememberLiamMessage(from, messageId(sent));
    } catch (e) {
      if (e && e.reachoutLocked) holdReply(from, reply, { quoted: msg });
      else throw e;
    } finally {
      stopTyping(from);
    }
  } catch (e) {
    stopAllTyping();
    lastInboundError = String(e && e.message ? e.message : e).slice(0, 400);
    console.log(`\n💀 MSG HANDLER ERROR: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// InstaBox pentest VM (members need one-time owner approval)
// ---------------------------------------------------------------------------
const INSTABOX_API_KEY = String(process.env.INSTABOX_API_KEY || "").trim();
// Optional: when unset, the first machine in the workspace is used, and one is
// created from the agent-browser template if the workspace has none yet.
let INSTABOX_MACHINE_ID = String(process.env.INSTABOX_MACHINE_ID || "").trim();
const INSTABOX_API_URL = String(process.env.INSTABOX_API_URL || "https://api.instabox.sh").replace(/\/+$/, "").replace(/\/v1$/, "");
// Where the VM's Playwright package lives. InstaBox exec runs as root, and
// Python ignores the user site-packages for root, so a plain `pip install`
// lands somewhere the interpreter will not import. Installing with --target
// and putting this directory on PYTHONPATH is reliable either way.
const INSTABOX_PYLIB_DIR = String(process.env.INSTABOX_PYLIB_DIR || "/data/home/liam_pylibs");

function instaboxIdempotency(prefix, target = "liam") {
  // Lifecycle retries must reuse the same key, including across a redeploy.
  // Deriving it from the account key and target avoids duplicate machines or
  // duplicate start charges when a response is lost. The key itself is never
  // logged or returned.
  const digest = crypto.createHash("sha256")
    .update(INSTABOX_API_KEY).update("\0").update(String(target)).digest("hex");
  return `${prefix}-${digest.slice(0, 32)}`;
}

// One place for every InstaBox HTTP call. Lifecycle calls need an
// Idempotency-Key; exec does not. Errors carry InstaBox's own code.
async function instaboxRequest(pathname, opts = {}) {
  if (!INSTABOX_API_KEY) {
    throw new BadRequest("InstaBox is not configured (set INSTABOX_API_KEY)");
  }
  const headers = {
    "X-API-Key": INSTABOX_API_KEY,
    "Authorization": "Bearer " + INSTABOX_API_KEY,
    "Accept": "application/json",
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idempotency) headers["Idempotency-Key"] = opts.idempotency;
  const controller = new AbortController();
  const ms = Math.max(5000, Number(opts.timeoutMs) || 30000);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(INSTABOX_API_URL + pathname, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      const code = err.code ? " " + err.code : "";
      const detail = String(err.message || data.raw || raw || "").slice(0, 300);
      throw new BadRequest(`InstaBox HTTP ${res.status}${code}${detail ? ": " + detail : ""}`);
    }
    return data;
  } catch (e) {
    if (e && e.name === "AbortError") throw new BadRequest("InstaBox request timed out");
    if (e instanceof BadRequest) throw e;
    throw new BadRequest(`InstaBox request failed: ${typeName(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Lifecycle changes answer 202 with an operation; follow it to the end.
async function instaboxWaitOperation(id, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let op = null;
  while (Date.now() < deadline) {
    op = await instaboxRequest(`/v1/operations/${encodeURIComponent(id)}?wait=25s`, { timeoutMs: 40000 });
    const state = String((op && op.state) || "");
    if (state === "succeeded") return op;
    if (state === "failed") {
      const err = (op && op.error) || {};
      throw new BadRequest(`InstaBox operation failed${err.code ? " (" + err.code + ")" : ""}: ${String(err.message || "").slice(0, 200)}`);
    }
  }
  throw new BadRequest("InstaBox operation timed out");
}

// The workspace has at most one free machine. Reuse it, or create it once.
//
// A configured INSTABOX_MACHINE_ID can belong to a different InstaBox account
// (for example after swapping in a key from a new account). Trusting it blindly
// made every call fail, so it is validated against this account's machine list
// once per process; if it is not there it is ignored and discovery or creation
// takes over instead.
let instaboxMachineChecked = false;

async function instaboxMachineId() {
  if (INSTABOX_MACHINE_ID && instaboxMachineChecked) return INSTABOX_MACHINE_ID;
  let machines = null;
  try {
    const list = await instaboxRequest("/v1/machines");
    machines = Array.isArray(list && list.machines) ? list.machines : [];
  } catch (e) {
    // Cannot reach InstaBox to validate; trust the configured id for this call
    // and let exec surface the real error.
    if (INSTABOX_MACHINE_ID) return INSTABOX_MACHINE_ID;
    throw e;
  }
  if (INSTABOX_MACHINE_ID) {
    const known = machines.some((m) => String((m && m.id) || "") === INSTABOX_MACHINE_ID);
    if (known) {
      instaboxMachineChecked = true;
      return INSTABOX_MACHINE_ID;
    }
    console.log(`warn: configured InstaBox machine ${INSTABOX_MACHINE_ID} is not in this account; using the account's own machine instead`);
    INSTABOX_MACHINE_ID = "";
  }
  if (machines.length) {
    INSTABOX_MACHINE_ID = String(machines[0].id || "");
    if (INSTABOX_MACHINE_ID) {
      instaboxMachineChecked = true;
      console.log("info: InstaBox using machine", INSTABOX_MACHINE_ID);
      return INSTABOX_MACHINE_ID;
    }
  }
  console.log("info: InstaBox has no machine; creating one (agent-browser)");
  const op = await instaboxRequest("/v1/machines", {
    method: "POST",
    body: { templateId: "agent-browser", name: "liam" },
    idempotency: instaboxIdempotency("liam-create"),
  });
  const done = await instaboxWaitOperation(op && op.id, 240000);
  const machine = (done && done.machine) || {};
  INSTABOX_MACHINE_ID = String((op && op.machineId) || machine.id || "");
  if (!INSTABOX_MACHINE_ID) throw new BadRequest("InstaBox created a machine but returned no id");
  instaboxMachineChecked = true;
  console.log("info: InstaBox created machine", INSTABOX_MACHINE_ID);
  return INSTABOX_MACHINE_ID;
}

// A free machine pauses when idle. `wake` resumes an idle-suspended machine
// (no Idempotency-Key needed); a manual stop/suspend needs `start`. Either way
// exec would auto-resume an idle machine, so this is a best-effort head start.
async function instaboxEnsureRunning(id) {
  let info;
  try {
    info = await instaboxRequest(`/v1/machines/${encodeURIComponent(id)}`);
  } catch (e) {
    return; // let exec surface the real error
  }
  if (String(info && info.state) === "running") return;
  console.log("info: InstaBox machine is", String(info && info.state) || "unknown", "- waking it");
  try {
    await instaboxRequest(`/v1/machines/${encodeURIComponent(id)}/wake`, { method: "POST" });
    return;
  } catch (e) {
    if (!(e instanceof BadRequest) || !/HTTP 409/.test(e.message)) return;
  }
  const op = await instaboxRequest(`/v1/machines/${encodeURIComponent(id)}/start`, {
    method: "POST",
    idempotency: instaboxIdempotency("liam-start", id),
  });
  if (op && op.state === "succeeded") return;
  await instaboxWaitOperation(op && op.id, 180000);
}

async function instaboxExec(command, timeoutSeconds = 120, cwd = "") {
  const text = String(command || "").trim();
  if (!text) throw new BadRequest("command is empty");
  if (text.length > 8000) throw new BadRequest("command is too long");
  const timeout = Math.min(3600, Math.max(1, Number.parseInt(timeoutSeconds, 10) || 120));
  const machine = await instaboxMachineId();
  await instaboxEnsureRunning(machine);
  const body = { cmd: text, timeoutSeconds: timeout };
  if (cwd) body.cwd = String(cwd).slice(0, 4000);
  const data = await instaboxRequest(`/v1/machines/${encodeURIComponent(machine)}/exec`, {
    method: "POST", body, timeoutMs: (timeout + 20) * 1000,
  });
  const out = [data.stdout, data.stderr].filter((v) => v != null && String(v).length).join("\n");
  const exit = data.exitCode != null ? data.exitCode : (data.exit_code != null ? data.exit_code : "?");
  let textOut = `exit=${exit}\n${out || "(no output)"}`;
  if (data.timedOut) textOut = "command timed out\n" + textOut;
  return textOut.length > 8000 ? textOut.slice(0, 8000) + "\n… [truncated]" : textOut;
}

// Raw file transfer, used to move browser scripts to the VM and screenshots
// back. The InstaBox file endpoints are not JSON: a PUT carries the file as its
// body and the content GET returns the bytes.
const INSTABOX_FILE_MAX = 8 * 1024 * 1024;

async function instaboxUpload(remotePath, buffer) {
  const p = String(remotePath || "").trim();
  if (!p.startsWith("/")) throw new BadRequest("path must be absolute");
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (!data.length) throw new BadRequest("file is empty");
  if (data.length > INSTABOX_FILE_MAX) throw new BadRequest("file is too large to upload");
  const machine = await instaboxMachineId();
  await instaboxEnsureRunning(machine);
  const query = new URLSearchParams({ path: p, parents: "true" }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${INSTABOX_API_URL}/v1/machines/${encodeURIComponent(machine)}/files?${query}`, {
      method: "PUT",
      headers: {
        "X-API-Key": INSTABOX_API_KEY,
        "Authorization": "Bearer " + INSTABOX_API_KEY,
        "Content-Type": "application/octet-stream",
      },
      body: data,
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      throw new BadRequest(`InstaBox upload HTTP ${res.status}: ${String(raw).slice(0, 200)}`);
    }
    await res.arrayBuffer().catch(() => {});
    return { ok: true, bytes: data.length };
  } catch (e) {
    if (e && e.name === "AbortError") throw new BadRequest("InstaBox upload timed out");
    if (e instanceof BadRequest) throw e;
    throw new BadRequest(`InstaBox upload failed: ${typeName(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function instaboxDownload(remotePath) {
  const p = String(remotePath || "").trim();
  if (!p.startsWith("/")) throw new BadRequest("path must be absolute");
  const machine = await instaboxMachineId();
  await instaboxEnsureRunning(machine);
  const query = new URLSearchParams({ path: p }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${INSTABOX_API_URL}/v1/machines/${encodeURIComponent(machine)}/files/content?${query}`, {
      headers: {
        "X-API-Key": INSTABOX_API_KEY,
        "Authorization": "Bearer " + INSTABOX_API_KEY,
        "Accept": "application/octet-stream",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => "");
      throw new BadRequest(`InstaBox download HTTP ${res.status}: ${String(raw).slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > INSTABOX_FILE_MAX) throw new BadRequest("downloaded file is too large");
    return buf;
  } catch (e) {
    if (e && e.name === "AbortError") throw new BadRequest("InstaBox download timed out");
    if (e instanceof BadRequest) throw e;
    throw new BadRequest(`InstaBox download failed: ${typeName(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

function typeName(e) { return e && e.constructor ? e.constructor.name : "Error"; }

// ---------------------------------------------------------------------------
// Authenticated local endpoint: lets the Python tools ACT on this linked client
// ---------------------------------------------------------------------------
class BadRequest extends Error {}

const outboundLog = [];

function isGroupJid(value) {
  return /^\d{6,30}@g\.us$/i.test(String(value || "").trim());
}

function normalizeRecipient(value, allowGroup = false) {
  const raw = String(value || "").trim();
  if (allowGroup && isGroupJid(raw)) return raw;
  let match = /^(\d{6,20})@(?:c\.us|s\.whatsapp\.net|newsletter)$/i.exec(raw);
  if (match) return match[1] + "@s.whatsapp.net";
  match = /^(\d{6,20})@lid$/i.exec(raw);
  if (match) return match[1] + "@lid";
  if (/^\d{6,20}$/.test(raw)) return raw + "@s.whatsapp.net";
  throw new BadRequest("invalid recipient");
}

function normalizeGroup(value) {
  const raw = String(value || "").trim();
  if (!/^\d{6,30}@g\.us$/.test(raw)) throw new BadRequest("invalid group");
  return raw;
}

function assertAllowed(jid) {
  const p = bareId(jid);
  // The receive path uses dmAllowed() (owners, admins, and known members while
  // DMs are open). Sending must accept the same people, otherwise a member who
  // can DM Liam gets "not on the allowlist" when she replies with an image or a
  // voice note. DM_ALLOW also carries the LIAM_DM_ALLOWLIST extras.
  if (!DM_ALLOW.has(p) && !dmAllowed(p)) throw new BadRequest("recipient is not on the allowlist");
}

function assertRate() {
  const now = Date.now();
  while (outboundLog.length && now - outboundLog[0] > OUTBOUND_WINDOW) outboundLog.shift();
  if (outboundLog.length >= OUTBOUND_MAX) throw new BadRequest("too many outbound messages - slow down");
  outboundLog.push(now);
  // The 20/minute budget must survive a Render redeploy, otherwise a fresh
  // process starts with a fresh allowance while WhatsApp still counts the old
  // sends and the number trips its own reach-out limit.
  scheduleBridgeStateSave();
}

function assertOutbox(value) {
  const candidate = path.resolve(String(value || ""));
  let real;
  try { real = fs.realpathSync(candidate); } catch (e) { throw new BadRequest("file not found"); }
  const root = fs.realpathSync(OUTBOX_DIR);
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new BadRequest("file is outside the outbox");
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new BadRequest("not a file");
  if (stat.size <= 0 || stat.size > MAX_MEDIA) throw new BadRequest("file is empty or too large");
  return real;
}

function audioMime(provided, file) {
  const allowed = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/opus", "audio/mp4"]);
  if (provided) {
    const value = String(provided).split(";")[0].trim().toLowerCase();
    if (!allowed.has(value)) throw new BadRequest("unsupported audio type");
    return value;
  }
  const ext = path.extname(file).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4";
  throw new BadRequest("unsupported audio file");
}

function assertOwner(d) {
  const actor = bareId(d && d.sender);
  if (!/^\d{6,20}$/.test(actor)) throw new BadRequest("missing sender context");
  if (!OWNERS.includes(actor)) throw new BadRequest("only the owner can do that");
}

async function handleAction(d, ctx = {}) {
  if (!d || typeof d.action !== "string") throw new BadRequest("invalid request");
  const action = d.action;

  if (action === "send") {
    assertOwner(d);
    const to = normalizeRecipient(d.to, true);
    if (!isGroupJid(to)) assertAllowed(to);
    assertRate();
    const text = String(d.text == null ? "" : d.text);
    if (!text.trim()) throw new BadRequest("message is empty");
    if (text.length > 4096) throw new BadRequest("message is too long");
    const sent = await wa.sendMessage(to, text);
    return messageId(sent) || "sent";
  }

  if (action === "image") {
    assertOwner(d);
    const to = normalizeRecipient(d.to, true);
    if (!isGroupJid(to)) assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const caption = String(d.text || "").slice(0, 1024);
    const sent = await wa.sendMessage(to, { image: fs.readFileSync(file), caption });
    return messageId(sent) || "sent";
  }

  if (action === "voice") {
    // Owners may send a voice note to any allowed recipient. Members may send
    // one only to the chat they are already in, so a member can never voice a
    // third party. The agent defaults 'to' to the current chat; this check is
    // the backstop if it is ever asked for somewhere else.
    const actor = bareId(d.sender);
    if (!/^\d{6,20}$/.test(actor)) throw new BadRequest("missing sender context");
    const to = normalizeRecipient(d.to, true);
    if (!isGroupJid(to)) assertAllowed(to);
    if (!OWNERS.includes(actor)) {
      const chat = normalizeRecipient(d.chat, true);
      if (chat !== to) throw new BadRequest("you can only send a voice note to this chat");
    }
    assertRate();
    const file = assertOutbox(d.path);
    const mimetype = audioMime(d.mimetype, file);
    const sendMime = (mimetype === "audio/ogg" || mimetype === "audio/opus")
      ? "audio/ogg; codecs=opus"
      : mimetype;
    const sent = await wa.sendMessage(to, {
      audio: fs.readFileSync(file),
      mimetype: sendMime,
      ptt: true,
    });
    const id = messageId(sent) || "sent";
    console.log(`info: voice note sent to ${jidType(to)} (${sendMime}, id ${id})`);
    return id;
  }

  if (action === "leave") {
    assertOwner(d);
    const jid = normalizeGroup(d.jid);
    await wa.leaveGroup(jid);
    return "I've left the group";
  }

  if (action === "permission") {
    assertOwner(d);
    const jid = normalizeGroup(d.jid);
    const who = bareId(d.who);
    if (!/^\d{6,20}$/.test(who)) throw new BadRequest("invalid member");
    if (typeof d.allow !== "boolean") throw new BadRequest("allow must be true or false");
    setGroupPermission(jid, who, d.allow);
    return d.allow ? "okay, I'll reply " + who : "okay, I'll ignore " + who;
  }

  if (action === "stop") {
    assertOwner(d);
    writeFileAtomic(STOP_FILE, "1");
    return "stopping…";
  }

  if (action === "stop_agent") {
    // Hard stop straight from the dashboard. Killing the process clears any
    // pending turn immediately, instead of waiting for the in-agent stop flag
    // to be noticed mid-turn. A later power-on just respawns the agent.
    assertOwner(d);
    stopAgent();
    return "stopping…";
  }

  if (action === "offline") {
    // Deliberate stay-down: kill the child and leave a marker the watchdog
    // honours. WhatsApp stays linked and the bridge stays up.
    assertOwner(d);
    setAgentOffline(true);
    try { writeFileAtomic(STOP_FILE, "1"); } catch (e) {}
    stopAgent();
    scheduleBridgeStateSave();
    return "offline";
  }

  if (action === "start_agent") {
    // Power the agent back up. Clearing the offline marker and the stop flag
    // first means a fresh turn is not born already stopped or suppressed.
    assertOwner(d);
    setAgentOffline(false);
    try { writeFileAtomic(STOP_FILE, "0"); } catch (e) {}
    const proc = startAgent();
    scheduleBridgeStateSave();
    return proc ? "starting…" : "the agent could not be started";
  }

  if (action === "vps_exec") {
    // Members and admins may *request* a pentest command, but an owner must
    // approve each one. Owners run directly.
    const actor = bareId(d.sender);
    if (!/^\d{6,20}$/.test(actor)) throw new BadRequest("missing sender context");
    if (!OWNERS.includes(actor) && !ctx.approved) {
      const p = await createToolApproval("vps_exec", {
        command: String(d.command || "").slice(0, 8000),
        timeout: Number.parseInt(d.timeout, 10) || 120,
        cwd: String(d.cwd || "").slice(0, 500),
      }, actor, { chat: d.chat || actor, isGroup: !!d.group });
      throw new BadRequest(`owner approval required (request ${p.id}) — I've asked the owner`);
    }
    return instaboxExec(d.command, d.timeout, d.cwd);
  }

  if (action === "vps_upload" || action === "vps_download") {
    // Owner-only file transport for browser work. Liam runs Playwright on the
    // VM so headless Chromium never runs on (and starves) this container's
    // WhatsApp socket. These carry the script out and the screenshot back.
    assertOwner(d);
    const remotePath = String(d.path || "").trim();
    if (!remotePath.startsWith("/")) throw new BadRequest("path must be absolute");
    if (action === "vps_upload") {
      const data = Buffer.from(String(d.data || ""), "base64");
      if (!data.length) throw new BadRequest("data is empty");
      const result = await instaboxUpload(remotePath, data);
      return `uploaded ${result.bytes} bytes`;
    }
    const buf = await instaboxDownload(remotePath);
    return buf.toString("base64");
  }

  throw new BadRequest("unknown action");
}

// ---------------------------------------------------------------------------
// HTTP server: health, readiness, pairing pages, local tool API
// ---------------------------------------------------------------------------
function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(body);
}

function sendHtml(res, status, html, headers = {}) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(html);
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function safeEqual(a, b) {
  const given = Buffer.from(String(a || ""));
  const expected = Buffer.from(String(b || ""));
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function pairTokenOk(value) { return !!value && safeEqual(value, PAIR_TOKEN); }

function parseCookies(req) {
  const header = String(req.headers.cookie || "");
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch (e) { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function wantsSecureCookie(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  if (xf === "https") return true;
  return String(PUBLIC_URL || "").toLowerCase().startsWith("https://");
}

function pairCookieHeader(req) {
  const attrs = [
    `liam_pair=${encodeURIComponent(PAIR_TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=43200",
  ];
  if (wantsSecureCookie(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function sameOriginRequest(req) {
  if (String(req.headers["sec-fetch-site"] || "").toLowerCase() === "cross-site") return false;
  const origin = String(req.headers.origin || "");
  const referer = String(req.headers.referer || "");
  if (!origin && !referer) return true; // non-browser token clients
  const host = String(req.headers.host || "");
  let publicOrigin = "";
  try { if (PUBLIC_URL) publicOrigin = new URL(PUBLIC_URL).origin; } catch (e) {}
  for (const value of [origin, referer].filter(Boolean)) {
    try {
      const u = new URL(value);
      if (u.host === host || (publicOrigin && u.origin === publicOrigin)) return true;
    } catch (e) {}
  }
  return false;
}

function pairAuth(req, url, extraToken = "") {
  const header = String(req.headers.authorization || "");
  if (header.startsWith("Bearer ") && pairTokenOk(header.slice(7))) return { ok: true, via: "header" };
  const cookies = parseCookies(req);
  if (pairTokenOk(cookies.liam_pair)) return { ok: true, via: "cookie" };
  if (pairTokenOk(extraToken)) return { ok: true, via: "body" };
  const q = String((url && url.searchParams.get("token")) || "");
  if (pairTokenOk(q)) return { ok: true, via: "query" };
  return { ok: false, via: "" };
}

function authorizedWith(req, token) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), token);
}
function authorized(req) { return authorizedWith(req, TOOL_TOKEN); }
function claimsOwner(d) {
  const actor = bareId(d && d.sender);
  return !!actor && OWNERS.includes(actor);
}

function allowedHost(host) {
  const address = server.address();
  const port = (address && typeof address === "object" ? address.port : null) || PORT;
  return host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`;
}

function isLoopback(address) {
  const value = String(address || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

function isPrivateAddress(host) {
  const value = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "localhost" || value.endsWith(".localhost") || value.endsWith(".local")) return true;
  const kind = net.isIP(value);
  if (!kind) return false;
  if (kind === 6) {
    const v = value.split("%")[0];
    if (v === "::1" || v === "::") return true;
    if (/^f[cd][0-9a-f]:/.test(v) || /^fe[89ab][0-9a-f]:/.test(v)) return true;
    if (/^::ffff:/.test(v)) return isPrivateAddress(v.slice(7));
    return false;
  }
  const octets = value.split(".").map((n) => Number.parseInt(n, 10));
  if (octets.length !== 4 || octets.some((n) => !Number.isFinite(n))) return true;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function safeExternalUrl(raw) {
  let url;
  try { url = new URL(String(raw || "")); } catch (e) { return null; }
  if (!/^https?:$/i.test(url.protocol)) return null;
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (!host || isPrivateAddress(host)) return null;
  return url.toString();
}

function redactLogs(logs) {
  return logs.map((entry) => {
    let line = String(entry && entry.line || "");
    line = line
      .replace(/(📩[^\n]*?:\s*).+$/, "$1[redacted]")
      .replace(/(💬[^\n]*?:\s*).+$/, "$1[redacted]")
      .replace(/(AGENT ERROR:|TOOL ACTION FAILED:|MSG HANDLER ERROR:|probeReply:|emailProbe:).+$/i, "$1 [redacted]")
      .replace(/\b\d{7,15}\b/g, (value) => maskPhone(value));
    return { ...entry, line };
  });
}

function maskedLinkMarker(marker) {
  if (!marker || typeof marker !== "object") return marker || null;
  const out = { ...marker };
  if (out.wid) {
    out.widKind = jidType(out.wid);
    out.wid = maskPhone(out.wid);
  }
  return out;
}

function diagOwnerTarget(raw) {
  // Diagnostic sends use the lower-value pairing token, so they must never be
  // able to message an arbitrary number or bypass the outbound budget.
  const to = String(raw || OWNERS[0]).replace(/\D/g, "");
  if (!OWNERS.includes(to)) throw new BadRequest("diagnostics can only use the owner's number");
  return to;
}

function statusPayload() {
  return {
    ok: true,
    status: waState,
    detail: waStateDetail,
    whatsappReady: waState === "ready",
    agentRunning: !!(agentProc && agentProc.exitCode === null && !agentProc.killed),
    agentOffline,
    mode: agentOffline ? "offline"
      : (waState !== "ready" ? "unlinked"
        : (agentProc && agentProc.exitCode === null && !agentProc.killed ? "online" : "agent-down")),
    needsQr: waState === "needs_qr",
    hasSessionData: hasSessionData(),
    linkedMarker: hasLinkMarker(),
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    memoryMiB: containerMemoryMiB(),
    memory: containerMemoryInfo(),
    lastQrAt: waLastQrAt || null,
    lastError: waInitError ? waInitError.split("\n")[0].slice(0, 300) : "",
    pairingEnabled: !!PAIR_TOKEN && waState !== "ready",
    pendingGroupPermissions: pendingPerms.size,
    pendingToolApprovals: pendingTools.size,
    // WhatsApp's own reach-out time-lock: when active, replies cannot be
    // delivered no matter what, and it is not a fault of this process.
    sendingBlocked: reachoutLockActive(),
    sendingBlockedUntil: reachoutLock && reachoutLock.isActive ? reachoutLock.endsAt : null,
    heldReplies: heldReplies.length,
  };
}

function pageShell(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>` +
    `body{font-family:system-ui,sans-serif;max-width:44rem;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}` +
    `code,pre{background:#222;padding:.2rem .4rem;border-radius:.3rem;word-break:break-all}` +
    `input{font-size:1.2rem;padding:.6rem;width:100%;box-sizing:border-box;background:#222;color:#eee;border:1px solid #555;border-radius:.4rem}` +
    `button{font-size:1.1rem;padding:.6rem 1rem;margin-top:.8rem;border:0;border-radius:.4rem;background:#25d366;color:#041}` +
    `img{max-width:100%;background:#fff;padding:1rem;border-radius:.5rem}` +
    `a{color:#7dd3fc}` +
    `</style></head><body>${body}</body></html>`;
}

function pairPage(opts = {}) {
  // Best practice: never place the pairing token in URLs. Authentication is via
  // HttpOnly cookie (set after a secure token submission/redirect) or a token
  // field/header in a request. The page uses clean URLs only.
  const action = "/pair";
  const value = opts.phone ? escapeHtml(opts.phone) : BOT_PHONE;
  let result = "";
  if (opts.error) {
    result = `<div style="border:1px solid #7f1d1d;background:#2a1215;padding:.8rem 1rem;border-radius:.5rem;margin-bottom:1rem">` +
      `<p style="margin:0;color:#fecaca"><strong>Could not get a code.</strong> ${escapeHtml(opts.error)}</p></div>`;
  }
  const tokenField = opts.needToken
    ? `<label for="token" style="display:block;margin-top:.8rem">Pairing token</label>` +
      `<input id="token" name="token" type="password" autocomplete="off" placeholder="Paste LIAM_PAIR_TOKEN" required>`
    : "";
  if (opts.code) {
    const formatted = opts.code.length === 8 ? `${opts.code.slice(0, 4)}-${opts.code.slice(4)}` : opts.code;
    const asked = opts.requestedAt ? new Date(opts.requestedAt).toLocaleTimeString() : "";
    result = `<p>Type this code into WhatsApp <strong>now</strong>:</p>` +
      `<p><code id="code" style="font-size:1.7rem;letter-spacing:.15em">${escapeHtml(formatted)}</code></p>` +
      `<p style="opacity:.8">Requested at ${escapeHtml(asked)}. <strong>Do not close or reload this page.</strong> ` +
      `The code expires in about a minute.</p>` +
      `<p id="age" style="color:#fca5a5;font-weight:600"></p>` +
      `<script>(function(){var t0=Date.now();setInterval(function(){` +
      `var s=Math.round((Date.now()-t0)/1000);var e=document.getElementById('age');if(!e)return;` +
      `e.textContent = s>75 ? 'This code has almost certainly expired - press the button once for a new one.' : '';` +
      `},1000);})();</script>`;
    return pageShell("Liam pairing", `<h1>Pair Liam</h1>${result}` +
      `<form method="post" action="${action}">` +
      `<input type="hidden" name="phone" value="${value}">` +
      `${tokenField}` +
      `<button type="submit">Get a new code</button></form>`);
  }
  return pageShell("Liam pairing", `<h1>Pair Liam</h1>${result}` +
    `<ol style="line-height:1.7">` +
    `<li>Keep this page open.</li>` +
    `<li>On the bot phone, open <strong>WhatsApp Business</strong>.</li>` +
    `<li>Tap <strong>Settings &rarr; Linked devices &rarr; Link a device</strong>.</li>` +
    `<li>Tap <strong>Link with phone number instead</strong>.</li>` +
    `<li>Then press the button below and type the code on the phone <strong>immediately</strong>.</li>` +
    `</ol>` +
    `<p style="opacity:.8">WhatsApp allows at most 4 linked devices. If the phone says the list is full, ` +
    `remove old <strong>Liam</strong> entries there first.</p>` +
    `<form method="post" action="${action}">` +
    `<label for="phone">Bot number with country code (digits only)</label>` +
    `<input id="phone" name="phone" inputmode="numeric" autocomplete="tel" value="${value}" required>` +
    `${tokenField}` +
    `<button type="submit">Get pairing code</button></form>` +
    `<p style="opacity:.7">This page only asks WhatsApp for a code when you press the button. Sensitive actions use a secure session (no token in the URL).</p>`);
}

// ---------------------------------------------------------------------------
// Owner dashboard
// ---------------------------------------------------------------------------
// dashboard.html is a static shell loaded once. Only the CSP nonce and the bot
// phone are injected, so the page can stay a readable file instead of a giant
// template living inside this process.
let DASHBOARD_HTML = "";
try {
  DASHBOARD_HTML = fs.readFileSync(path.join(BASE_DIR, "dashboard.html"), "utf8");
} catch (e) {
  console.log("warn: dashboard.html could not be loaded:",
    String(e && e.message ? e.message : e).slice(0, 160));
}

function formatPairCode(code) {
  const clean = String(code || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return clean.length === 8 ? clean.slice(0, 4) + "-" + clean.slice(4) : clean;
}

function dashboardCsp(nonce) {
  const script = nonce ? `script-src 'nonce-${nonce}'; ` : "script-src 'none'; ";
  return {
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; " + script +
      "connect-src 'self'; img-src data:; form-action 'self'; " +
      "base-uri 'none'; frame-ancestors 'none'",
  };
}

function dashboardPage(nonce) {
  if (!DASHBOARD_HTML) {
    return pageShell("Liam dashboard",
      "<h1>Dashboard unavailable</h1><p>dashboard.html is missing from this deployment.</p>");
  }
  return DASHBOARD_HTML
    .replace(/__NONCE__/g, nonce)
    .replace(/__BOT_PHONE__/g, escapeHtml(BOT_PHONE));
}

function dashboardLoginPage(error) {
  const msg = error ? `<p class="err">${escapeHtml(error)}</p>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
    `<meta name="theme-color" content="#05070a">` +
    `<title>liam // owner access</title><style>` +
    `:root{color-scheme:dark}*{box-sizing:border-box}` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;padding:1.5rem;` +
    `background:#05070a;color:#c8d6df;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}` +
    `body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.4;` +
    `background-image:linear-gradient(rgba(94,234,212,.035) 1px,transparent 1px),` +
    `linear-gradient(90deg,rgba(94,234,212,.035) 1px,transparent 1px);background-size:28px 28px}` +
    `.gate{position:relative;width:min(100%,24rem);border:1px solid #16222b;background:#0a0f14;` +
    `padding:1.4rem;box-shadow:0 0 60px rgba(94,234,212,.06)}` +
    `.gate:before,.gate:after{content:"";position:absolute;width:14px;height:14px;border-color:#5eead4;border-style:solid}` +
    `.gate:before{top:-1px;left:-1px;border-width:1px 0 0 1px}` +
    `.gate:after{bottom:-1px;right:-1px;border-width:0 1px 1px 0}` +
    `.kicker{margin:0 0 .4rem;font-size:.62rem;letter-spacing:.28em;color:#5eead4;text-transform:uppercase}` +
    `h1{margin:0;font-size:1.35rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase}` +
    `.sub{margin:.6rem 0 1.2rem;color:#6b7f8c;font-size:.8rem;line-height:1.5}` +
    `label{display:block;margin:0 0 .35rem;font-size:.62rem;letter-spacing:.18em;color:#6b7f8c;text-transform:uppercase}` +
    `input{width:100%;padding:.75rem .8rem;background:#05070a;color:#e6f1f5;border:1px solid #1f3a45;` +
    `border-radius:2px;font:inherit;font-size:1rem;outline:none}` +
    `input:focus{border-color:#5eead4;box-shadow:0 0 0 1px rgba(94,234,212,.25)}` +
    `button{width:100%;margin-top:.8rem;padding:.8rem;background:#5eead4;color:#04110f;border:0;` +
    `font:inherit;font-weight:700;letter-spacing:.14em;text-transform:uppercase;cursor:pointer}` +
    `button:active{transform:translateY(1px)}` +
    `.err{margin:.8rem 0 0;padding:.55rem .7rem;border-left:2px solid #f87171;` +
    `background:rgba(248,113,113,.08);color:#fca5a5;font-size:.75rem}` +
    `.fine{margin:1rem 0 0;color:#4b5f6b;font-size:.65rem;line-height:1.5}` +
    `</style></head><body><main class="gate">` +
    `<p class="kicker">liam // control</p><h1>owner access</h1>` +
    `<p class="sub">enter the pairing token to open the control surface. this page is owner-only.</p>` +
    msg +
    `<form method="post" action="/dashboard/login">` +
    `<label for="token">pairing token</label>` +
    `<input id="token" name="token" type="password" autocomplete="current-password" required autofocus>` +
    `<button type="submit">unlock</button></form>` +
    `<p class="fine">the token is exchanged for an http-only session cookie and is never kept in the url.</p>` +
    `</main></body></html>`;
}

function dashboardStatePayload() {
  const agentAlive = !!(agentProc && agentProc.exitCode === null && !agentProc.killed);
  return {
    ok: true,
    waState,
    waDetail: waStateDetail,
    linked: waState === "ready",
    agentRunning: agentAlive,
    agentOffline,
    mode: agentOffline ? "offline"
      : (waState !== "ready" ? "unlinked" : (agentAlive ? "online" : "agent-down")),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    memoryMiB: containerMemoryMiB(),
    inboundCount,
    lastInboundAt: lastInboundAt || null,
    lastOutboundAt: lastOutboundAt || null,
    lastAgentRequestAt: lastAgentRequestAt || null,
    lastAgentStartedAt: lastAgentStartedAt || null,
    lastAgentReplyAt: lastAgentReplyAt || null,
    lastTurnMs: (lastAgentStartedAt && lastAgentReplyAt)
      ? Math.max(0, lastAgentReplyAt - lastAgentStartedAt) : null,
    lastQueueWaitMs: (lastAgentRequestAt && lastAgentStartedAt)
      ? Math.max(0, lastAgentStartedAt - lastAgentRequestAt) : null,
    lastAgentError: String(lastAgentError || "").slice(0, 400),
    sendingBlocked: reachoutLockActive(),
    pendingToolApprovals: pendingTools.size,
    pendingGroupPermissions: pendingPerms.size,
    botPhone: BOT_PHONE,
    pairCooldownMs: PAIRING_COOLDOWN_MS,
    lastPairAt: lastPairAt || null,
    lastPairCode: lastPairCode ? formatPairCode(lastPairCode) : null,
    pairingError: pairingError || "",
    config: {
      image: !!process.env.GOOGLE_API_KEY,
      voice: true,
      tavily: !!process.env.TAVILY_API_KEY,
      brave: !!process.env.BRAVE_API_KEY,
      serper: !!process.env.SERPER_API_KEY,
      instabox: !!INSTABOX_API_KEY,
      email: !!(process.env.LIAM_EMAIL_HOST && process.env.LIAM_EMAIL_USER
        && process.env.LIAM_EMAIL_PASSWORD),
    },
  };
}

function readJsonBody(req, limit) {
  return readBody(req, limit).then((raw) => {
    if (!raw) return {};
    try { return JSON.parse(raw); }
    catch (e) { throw new BadRequest("invalid json"); }
  });
}

function dashboardPost(req, res, url, run) {
  (async () => {
    try {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
        req.resume();
        return sendJson(res, 415, { ok: false, error: "content-type must be application/json" });
      }
      const auth = pairAuth(req, url);
      if (!auth.ok || auth.via === "query") {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }
      if (!sameOriginRequest(req)) {
        return sendJson(res, 403, { ok: false, error: "invalid origin" });
      }
      const data = await readJsonBody(req, 16 * 1024);
      const result = await run(data);
      return sendJson(res, 200, { ok: true, ...(result || {}) });
    } catch (e) {
      const status = e instanceof BadRequest ? 400 : 500;
      return sendJson(res, status, {
        ok: false,
        error: String(e && e.message ? e.message : e).slice(0, 600),
      });
    }
  })();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    // Collect Buffer chunks and decode once at the end. String concatenation
    // corrupts a multibyte character that happens to straddle two chunks.
    const parts = [];
    let size = 0;
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        done = true;
        reject(new BadRequest("request too large"));
        return;
      }
      parts.push(buf);
    });
    req.on("end", () => { if (!done) resolve(Buffer.concat(parts).toString("utf8")); });
    req.on("error", reject);
  });
}

// A code request writes a half identity into creds.json before WhatsApp answers.
// Cancelling or failing must return to a clean, unlinked profile so the next
// attempt is not rejected by a stale companion registration.
async function cancelPairing() {
  pairingEpoch += 1;
  pairingInFlight = null;
  lastPairCode = null;
  pairingError = "";
  noteWaEvent("pairing_cancelled");
  await closeSocket("pairing cancelled");
  if (!hasLinkMarker()) {
    // Never delete a completed login; only drop a half-finished one.
    try { fs.rmSync(SESSION_PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
  }
  if (waState !== "ready") {
    setWaState("needs_qr", "pairing cancelled - press the button once for a new code");
    // Bring a clean socket up so the next button press can request a code.
    initializeWhatsApp("pairing cancelled").catch(() => {});
  }
  return true;
}

// Wipe the local login and connect a brand-new socket. A half-linked Baileys
// profile can keep WhatsApp in a companion-registration state that refuses new
// codes; this returns to a clean first-run profile without a Render restart.
let resetInFlight = null;
async function resetWhatsApp(reason, opts = {}) {
  if (resetInFlight) return resetInFlight;
  const wipe = opts.wipe !== false;
  resetInFlight = (async () => {
    noteWaEvent("reset", `${reason || "manual reset"}${wipe ? "" : " (login kept)"}`);
    console.log(`\n♻️ Resetting WhatsApp: ${reason || "manual reset"}${wipe ? " (clean profile)" : " (login kept)"}`);
    setWaState("starting", wipe ? "resetting WhatsApp (clean profile)" : "reconnecting (login kept)");
    stopAgent();
    pairingEpoch += 1;
    readyHandled = false;
    lastPairCode = null;
    pairingError = "";
    pairingInFlight = null;
    waInitError = "";
    removeQrFile();
    await closeSocket(reason || "reset");
    if (wipe) {
      clearLinkMarker();
      try { fs.rmSync(SESSION_PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
    }
    setWaState(wipe ? "needs_qr" : "starting",
      wipe ? "clean profile - press the button once for a code" : "reconnecting with the saved login");
    await initializeWhatsApp(wipe ? "reset" : "reconnect");
  })();
  try {
    return await resetInFlight;
  } finally {
    resetInFlight = null;
  }
}

// Recover in place instead of exiting. Exiting kills the HTTP server, so the
// pairing page shows Render's "service unavailable" page exactly when the phone
// is mid-link. Only a repeated failure loop falls back to a container restart.
let autoResetTimes = [];
let lastMemoryReset = 0;
function autoReset(reason) {
  const now = Date.now();
  autoResetTimes = autoResetTimes.filter((t) => now - t < 10 * 60 * 1000);
  if (autoResetTimes.length >= 3) {
    noteWaEvent("exit", reason);
    console.log("warn: automatic recovery keeps failing; exiting so Render restarts the container");
    setTimeout(() => process.exit(1), 3000);
    return;
  }
  autoResetTimes.push(now);
  setTimeout(() => {
    resetWhatsApp(reason).catch((e) => console.log("warn: auto reset failed:", String(e)));
  }, 3000);
}

// Render kills the whole container (and any in-progress link) when the free
// plan's memory limit is exceeded. Recycle just the socket before that happens.
// The profile is kept, so a linked account reconnects without re-pairing.
let memoryGuardTimer = null;
function startMemoryGuard() {
  if (memoryGuardTimer) return;
  // Opt-in only: a boot peak can still happen, and recycling during a login
  // would cancel the link. Set LIAM_MEM_LIMIT_MB to a value below the plan limit
  // to enable an early socket recycle.
  const limit = envInt("LIAM_MEM_LIMIT_MB", 0, 0);
  if (!Number.isFinite(limit) || limit < 300) return;
  memoryGuardTimer = setInterval(() => {
    const used = containerMemoryMiB();
    if (!used || used < limit) return;
    if (resetInFlight || linkHandshakeActive()) return;
    if (waState === "starting" || waState === "restoring") return;
    if (Date.now() - lastMemoryReset < 5 * 60 * 1000) return;
    lastMemoryReset = Date.now();
    console.log(`warn: memory at ${used} MiB (limit ${limit} MiB); recycling the WhatsApp socket to avoid an out-of-memory kill`);
    noteWaEvent("memory_reset", `${used} MiB`);
    resetWhatsApp(`memory guard (${used} MiB)`, { wipe: false })
      .catch((e) => console.log("warn: memory recycle failed:", String(e)));
  }, 20000);
  if (typeof memoryGuardTimer.unref === "function") memoryGuardTimer.unref();
}

// Render's free plan sleeps an idle web service, which stops WhatsApp delivery
// entirely until something wakes it. UptimeRobot is the reliable outside wake-up;
// this self-ping keeps the idle timer from expiring in the first place, so Liam
// stays reachable even if the monitor is paused or misconfigured.
let keepAliveTimer = null;
function startKeepAlive() {
  if (keepAliveTimer) return;
  if (String(process.env.LIAM_DISABLE_KEEPALIVE || "") === "1") return;
  if (String(process.env.LIAM_DISABLE_AGENT || "") === "1") return;
  if (!PUBLIC_URL || !/^https?:\/\//i.test(PUBLIC_URL)) {
    console.log("info: keep-alive off (no public URL known)");
    return;
  }
  const intervalMs = envInt("LIAM_KEEPALIVE_MS", 600000, 60000);
  keepAliveTimer = setInterval(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    fetch(PUBLIC_URL + "/health", { signal: controller.signal })
      .then(() => {})
      .catch(() => {})
      .finally(() => clearTimeout(timer));
  }, intervalMs);
  if (typeof keepAliveTimer.unref === "function") keepAliveTimer.unref();
  console.log(`info: keep-alive self-ping every ${Math.round(intervalMs / 1000)}s -> ${PUBLIC_URL}/health`);
}

// Re-check the WhatsApp reach-out time-lock every few minutes so the block is
// noticed soon after it lifts and so sends resume without a restart.
let reachoutTimer = null;
function startReachoutWatch() {
  if (reachoutTimer) return;
  reachoutTimer = setInterval(() => { void refreshReachoutLock(); }, 5 * 60 * 1000);
  if (typeof reachoutTimer.unref === "function") reachoutTimer.unref();
}

function friendlyWaError(message) {
  const text = String(message || "");
  if (/429|rate[- ]?overlimit|too many|overlimit/i.test(text)) {
    return `WhatsApp is limiting code requests for this number. Wait ${humanWindow(RATE_LIMIT_COOLDOWN_MS)}, ` +
      "remove old Liam entries from Linked devices on the phone, then try once.";
  }
  if (/couldn'?t link|bad session|401|not[- ]?authorized|conflict|already/i.test(text)) {
    return "WhatsApp refused this link attempt. Remove old Liam entries from Linked devices " +
      "on the phone, then try again.";
  }
  if (/timeout|timed out|timedout/i.test(text)) {
    return "WhatsApp did not answer in time. Try once more.";
  }
  return text.split("\n")[0].slice(0, 200) || "unknown WhatsApp error";
}

async function requestPairing(phone) {
  const normalized = String(phone || "").replace(/\D/g, "");
  if (!/^\d{7,15}$/.test(normalized)) {
    throw new BadRequest("phone must be the full international number, digits only (e.g. 447881161023)");
  }
  if (waState === "ready" || registered) throw new BadRequest("this WhatsApp account is already linked");
  if (pairingInFlight) return pairingInFlight;
  // WhatsApp rate-limits code requests hard and every request restarts the
  // block. Give the same code back while it is fresh, then enforce a cooldown.
  const sinceLast = lastPairAt ? Date.now() - lastPairAt : Infinity;
  if (sinceLast < 60 * 1000 && lastPairCode) return lastPairCode;
  if (sinceLast < PAIRING_COOLDOWN_MS) {
    const wait = Math.ceil((PAIRING_COOLDOWN_MS - sinceLast) / 1000);
    throw new BadRequest(
      `a code was requested ${Math.round(sinceLast / 1000)} seconds ago; wait ${wait} seconds before asking again - ` +
      "every request restarts WhatsApp's own rate limit");
  }
  pairingInFlight = (async () => {
    const epoch = pairingEpoch;
    const deadline = Date.now() + 60000;
    // requestPairingCode() is only valid after the socket has received its
    // first QR payload. Calling it earlier is the classic "couldn't link
    // device" failure, so wait for that stage instead of guessing.
    while (Date.now() < deadline) {
      if (epoch !== pairingEpoch) throw new BadRequest("pairing was cancelled");
      // The phone can finish linking while a code request is still looping.
      // Waiting for the QR stage in that case only produces a spurious timeout.
      if (waState === "ready" || registered || socketIsRegistered()) break;
      if (sock && sockReadyForPairing) break;
      if (!sock && !connecting && !reconnectTimer) {
        await initializeWhatsApp("pairing code request").catch(() => {});
      }
      await sleep(500);
    }
    if (waState === "ready" || registered || socketIsRegistered()) {
      throw new BadRequest("this WhatsApp account was just linked - no code is needed");
    }
    if (!sock || !sockReadyForPairing) {
      throw new BadRequest("WhatsApp is still starting - wait a few seconds and press the button again");
    }
    try {
      const code = await withTimeout(
        sock.requestPairingCode(normalized),
        90000,
        "WhatsApp did not answer the code request within 90 seconds",
      );
      if (epoch !== pairingEpoch) throw new BadRequest("pairing was cancelled");
      const clean = String(code || "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
      if (clean.length !== 8) throw new Error("WhatsApp returned an unexpected code");
      lastPairCode = clean;
      lastPairAt = Date.now();
      pairingError = "";
      setWaState("linking", "pairing code generated");
      noteWaEvent("pairing_code");
      return lastPairCode;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);
      const friendly = friendlyWaError(msg);
      pairingError = friendly;
      lastPairCode = null;
      lastPairAt = Date.now();  // enforce the cooldown after any failure
      noteWaEvent("pairing_failed", msg);
      console.log("warn: pairing code failed:", msg);
      try { await cancelPairing(); } catch (e2) {}
      throw new BadRequest("could not get a pairing code: " + friendly);
    }
  })();
  try { return await pairingInFlight; }
  finally { pairingInFlight = null; }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const pathname = url.pathname;
  const publicGet = req.method === "GET" && ["/health", "/ready", "/status", "/qr", "/pair", "/diag", "/cancelpair", "/reset", "/dashboard", "/dashboard/state", "/dashboard/logs"].includes(pathname);

  if (publicGet) {
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, status: "alive" }));
      return;
    }
    if (pathname === "/ready") {
      // Render readiness is about the WhatsApp socket. The Python agent is
      // reported separately and restarted in-process, so its crash must not
      // cause a container restart that would drop the linked session.
      const ready = waState === "ready";
      sendJson(res, ready ? 200 : 503, { ...statusPayload(), ok: ready });
      return;
    }
    if (pathname === "/status") {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (pathname === "/dashboard") {
      // The pairing token is the owner's browser credential. It is accepted
      // once in the query only to establish the secure session cookie, then
      // stripped from the URL. The owner token never reaches the browser.
      const auth = pairAuth(req, url);
      if (!auth.ok) return sendHtml(res, 403, dashboardLoginPage(""), dashboardCsp(""));
      if (auth.via === "query") {
        return sendHtml(res, 302, "", { Location: "/dashboard", "Set-Cookie": pairCookieHeader(req) });
      }
      const nonce = crypto.randomBytes(18).toString("base64");
      return sendHtml(res, 200, dashboardPage(nonce), dashboardCsp(nonce));
    }
    if (pathname === "/dashboard/state") {
      const auth = pairAuth(req, url);
      if (!auth.ok || auth.via === "query") {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }
      return sendJson(res, 200, dashboardStatePayload());
    }
    if (pathname === "/dashboard/logs") {
      const auth = pairAuth(req, url);
      if (!auth.ok || auth.via === "query") {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
      }
      const limit = Math.min(300, Math.max(1,
        Number.parseInt(url.searchParams.get("limit") || "200", 10) || 200));
      return sendJson(res, 200, { ok: true, logs: redactLogs(RECENT_LOGS.slice(-limit)) });
    }
    if (pathname === "/cancelpair") {
      const auth = pairAuth(req, url);
      if (!auth.ok) return sendJson(res, 403, { ok: false, msg: "forbidden" });
      if (auth.via === "query") {
        return sendJson(res, 302, { ok: true }, { Location: "/cancelpair", "Set-Cookie": pairCookieHeader(req) });
      }
      // A token in a link may only establish the secure session above. The
      // destructive action itself needs an explicit POST.
      return sendJson(res, 405, { ok: false, msg: "use POST to cancel pairing" });
    }
    if (pathname === "/reset") {
      const auth = pairAuth(req, url);
      if (!auth.ok) return sendJson(res, 403, { ok: false, msg: "forbidden" });
      if (auth.via === "query") {
        return sendJson(res, 302, { ok: true }, { Location: "/reset", "Set-Cookie": pairCookieHeader(req) });
      }
      return sendJson(res, 405, { ok: false, msg: "use POST to reset" });
    }
    if (pathname === "/diag") {
      // Unlinked-startup diagnostics, plus safe message counters once linked.
      // Message text is never stored or exposed; the pairing token is required.
      // Best practice: do not keep tokens in URLs; accept query token once only
      // to establish a secure session cookie, then redirect to a clean URL.
      const auth = pairAuth(req, url);
      if (!auth.ok) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1><p>Provide the pairing token via Authorization header or a secure pairing session.</p>"));
      if (auth.via === "query") {
        const clean = new URL(url.toString());
        clean.searchParams.delete("token");
        const loc = clean.pathname + (clean.search || "");
        return sendHtml(res, 302, "", { Location: loc, "Set-Cookie": pairCookieHeader(req) });
      }
      const agentAlive = !!(agentProc && agentProc.exitCode === null && !agentProc.killed);
      if (waState === "ready") {
        const base = {
          ok: true,
          status: waState,
          note: "linked; message text hidden",
          agentRunning: agentAlive,
          inboundCount,
          lastInboundAt: lastInboundAt || null,
          lastInboundKind,
          lastInboundPhone: maskPhone(lastInboundPhone),
          lastInboundFromType,
          lastInboundError,
          lastOutboundAt: lastOutboundAt || null,
          lastSendTargetType,
          lastSendError,
          recentSends: recentSendReport(),
          ackDebug: { messagesUpdateCount, receiptUpdateCount, samples: ackSamples.slice(-5) },
          wire: { ackNodeCount, ackSamples: ackNodeSamples.slice(-5), frameSizes: outFrameSizes.slice(-8) },
          lastAgentRequestAt: lastAgentRequestAt || null,
          lastAgentStartedAt: lastAgentStartedAt || null,
          lastAgentReplyAt: lastAgentReplyAt || null,
          lastTurnMs: (lastAgentStartedAt && lastAgentReplyAt)
            ? Math.max(0, lastAgentReplyAt - lastAgentStartedAt) : null,
          lastQueueWaitMs: (lastAgentRequestAt && lastAgentStartedAt)
            ? Math.max(0, lastAgentStartedAt - lastAgentRequestAt) : null,
          lastAgentTrace,
          lastAgentError,
          agentStderrTail: agentStderrTail.slice(-1200),
          // Read-only: which optional integrations have credentials present.
          // Never exposes the values, only whether each tool can work.
          config: {
            // Images still need a Google key; voice notes are free (edge-tts).
            image: !!process.env.GOOGLE_API_KEY,
            voice: true,
            search: {
              tavily: !!process.env.TAVILY_API_KEY,
              brave: !!process.env.BRAVE_API_KEY,
              serper: !!process.env.SERPER_API_KEY,
              duckduckgo: true,
            },
            instabox: {
              apiKey: !!INSTABOX_API_KEY,
              machineId: INSTABOX_MACHINE_ID || null,
              url: INSTABOX_API_URL,
            },
            email: !!(process.env.LIAM_EMAIL_HOST && process.env.LIAM_EMAIL_USER
              && process.env.LIAM_EMAIL_PASSWORD),
            dmAllowlist: DM_ALLOW.size,
            owners: OWNERS.length,
          },
          memoryMiB: containerMemoryMiB(),
          uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
          // Connection history (open/close/reconnect codes) with no message
          // text, so a flapping socket is visible while linked.
          events: waEvents.slice(-15),
          reachoutLock,
          heldReplies: heldReplies.length,
        };
        const probe = url.searchParams.get("probe");
        // Optional runtime Baileys log level, so a protocol bug can be watched
        // without a redeploy. Token-protected like everything else here.
        const waLog = url.searchParams.get("walog");
        if (waLog !== null) {
          if (waLogResetTimer) { clearTimeout(waLogResetTimer); waLogResetTimer = null; }
          const want = String(waLog).toLowerCase();
          waLogLevel = (want === "" || want === "silent" || want === "off") ? "silent" : want;
          // A trace requested for one debugging session must not keep logging
          // message content forever (or fill the in-memory log ring).
          if (waLogLevel !== "silent") {
            waLogResetTimer = setTimeout(() => {
              waLogLevel = "silent";
              waLogResetTimer = null;
            }, WA_LOG_ONCE_MS);
            if (typeof waLogResetTimer.unref === "function") waLogResetTimer.unref();
          }
        }
        if (probe === "instabox") {
          try {
            const list = await instaboxRequest("/v1/machines");
            const machines = Array.isArray(list && list.machines) ? list.machines : [];
            return sendJson(res, 200, {
              ...base,
              instaboxProbe: {
                ok: true,
                count: machines.length,
                machines: machines.slice(0, 5).map((m) => ({
                  id: m && m.id, name: m && m.name, state: m && m.state,
                  template: (m && (m.templateId || m.template)) || null,
                })),
              },
            });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              instaboxProbe: { ok: false, error: String(e && e.message ? e.message : e).slice(0, 400) },
            });
          }
        }
        if (probe === "vps") {
          // What does the free VM actually offer for browser work? Report the
          // interpreters, the Chromium binary and free space so the offload can
          // use what is really there instead of assuming.
          const script = [
            "import shutil, subprocess, sys",
            "def run(*a):",
            "    try:",
            "        return subprocess.run(a, capture_output=True, text=True, timeout=30).stdout.strip()",
            "    except Exception as e:",
            "        return 'err: %s' % e",
            "print('python', sys.version.split()[0])",
            "print('pip', run('python3', '-m', 'pip', '--version')[:80])",
            "print('node', run('node', '--version'))",
            "print('bun', run('bun', '--version'))",
            "try:",
            "    import playwright",
            "    print('playwright: python module present')",
            "except Exception as e:",
            "    print('playwright: missing (%s)' % e)",
            "for name in ('chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome'):",
            "    p = shutil.which(name)",
            "    if p:",
            "        print('browser:', name, '->', p)",
            "import glob",
            "for pattern in ('/usr/bin/*chrom*', '/opt/*chrom*', '/opt/google/chrome/chrome', '/root/.cache/ms-playwright/*'):",
            "    for hit in glob.glob(pattern)[:5]:",
            "        print('found:', hit)",
            "print('disk', run('df', '-h', '/data/home'))",
          ].join("\n");
          const heredoc = "export PYTHONPATH=" + JSON.stringify(INSTABOX_PYLIB_DIR)
            + "; python3 - <<'PY'\n" + script + "\nPY";
          try {
            const out = await instaboxExec(heredoc, 180);
            const result = { ok: true, out: String(out).slice(0, 3000) };
            if (String(url.searchParams.get("install") || "") === "1") {
              // One-time provisioning: add the Playwright Python package. The
              // template already ships Chromium, so no browser download is
              // needed - the scripts launch the system binary. Install into an
              // explicit --target directory because root ignores user site.
              const installScript = [
                "import os, subprocess",
                "def run(*a):",
                "    p = subprocess.run(a, capture_output=True, text=True)",
                "    return (p.stdout + p.stderr).strip()",
                "target = os.environ['LIAM_PYLIB_DIR']",
                "print('installing playwright...')",
                "print(run('python3', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--break-system-packages', '--target', target, 'playwright')[-1200:])",
                // Verify in a FRESH process. This interpreter looked for the
                // package before the install created the directory, so importing
                // it here would still report 'missing' even on success.
                "print('playwright import:', run('python3', '-c', 'import playwright.sync_api as p; print(p.__name__)'))",
              ].join("\n");
              try {
                const inst = await instaboxExec(
                  "export LIAM_PYLIB_DIR=" + JSON.stringify(INSTABOX_PYLIB_DIR)
                  + "; export PYTHONPATH=" + JSON.stringify(INSTABOX_PYLIB_DIR)
                  + "; python3 - <<'PY'\n" + installScript + "\nPY", 420);
                result.install = String(inst).slice(0, 2000);
              } catch (e) {
                result.install = "install failed: " + String(e && e.message ? e.message : e).slice(0, 300);
              }
            }
            const shotUrl = safeExternalUrl(url.searchParams.get("shot"));
            if (shotUrl) {
              // End-to-end proof: drive Chromium on the VM exactly as the
              // screenshot tool would, and report the PNG size.
              const shotScript = [
                "import os, sys",
                "from playwright.sync_api import sync_playwright",
                "url, out = sys.argv[1], sys.argv[2]",
                "exe = os.environ.get('LIAM_CHROMIUM_PATH') or None",
                "kw = dict(headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'])",
                "if exe:",
                "    kw['executable_path'] = exe",
                "with sync_playwright() as p:",
                "    b = p.chromium.launch(**kw)",
                "    pg = b.new_page(viewport={'width': 1366, 'height': 900})",
                "    pg.goto(url, wait_until='domcontentloaded', timeout=45000)",
                "    pg.screenshot(path=out)",
                "    b.close()",
                "print('shot bytes', os.path.getsize(out))",
              ].join("\n");
              const scriptPath = "/data/home/liam_browser/probe_shot.py";
              try {
                await instaboxUpload(scriptPath, Buffer.from(shotScript, "utf8"));
                const quoted = "'" + shotUrl.replace(/'/g, "'\\''") + "'";
                const chromeEnv = 'export PYTHONPATH=' + JSON.stringify(INSTABOX_PYLIB_DIR)
                  + '; export LIAM_CHROMIUM_PATH="$(command -v chromium '
                  + '|| command -v chromium-browser || command -v google-chrome || true)"; ';
                const cmd = chromeEnv + "python3 " + scriptPath + " " + quoted
                  + " /data/home/liam_browser/probe_shot.png";
                result.shot = String(await instaboxExec(cmd, 180)).slice(0, 800);
              } catch (e) {
                result.shot = "shot failed: " + String(e && e.message ? e.message : e).slice(0, 300);
              }
            } else if (url.searchParams.has("shot")) {
              result.shot = "shot skipped: only public http(s) URLs are allowed";
            }
            return sendJson(res, 200, { ...base, vpsProbe: result });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              vpsProbe: { ok: false, error: String(e && e.message ? e.message : e).slice(0, 400) },
            });
          }
        }
        if (probe === "groups") {
          // Which groups Liam is in, how they address members (pn vs lid), and
          // the shape of each participant identity field. No phone numbers are
          // returned - only the domain suffix - so this is safe as a diagnostic.
          try {
            const all = sock && typeof sock.groupFetchAllParticipating === "function"
              ? await sock.groupFetchAllParticipating() : {};
            const shape = (value) => {
              const s = String(value || "");
              const at = s.indexOf("@");
              return at >= 0 ? s.slice(at) : (s ? "(plain)" : "");
            };
            const groups = Object.values(all || {}).map((g) => ({
              subject: String(g.subject || "").slice(0, 60),
              mode: g.addressingMode || "",
              members: Array.isArray(g.participants) ? g.participants.length : 0,
              sample: (Array.isArray(g.participants) ? g.participants.slice(0, 3) : []).map((p) => ({
                id: shape(p && p.id),
                jid: shape(p && p.jid),
                lid: shape(p && p.lid),
                phoneNumber: shape(p && p.phoneNumber),
                admin: (p && (p.admin || p.isAdmin)) || null,
              })),
            }));
            return sendJson(res, 200, { ...base, groupsProbe: { count: groups.length, groups } });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              groupsProbe: { error: String(e && e.message ? e.message : e).slice(0, 400) },
            });
          }
        }
        if (probe === "logs") {
          // The last console lines help diagnose delivery problems, but some
          // lines echo messages. Redact those before exposing them here.
          return sendJson(res, 200, { ...base, logs: redactLogs(RECENT_LOGS.slice(-50)) });
        }
        if (probe === "send") {
          // Send one real message to the owner and report whether WhatsApp
          // accepted it. This isolates an outbound-delivery problem from the
          // inbound/agent path.
          const rawTo = url.searchParams.get("to");
          let to = "";
          try {
            to = diagOwnerTarget(rawTo);
            assertRate();
            const sent = await wa.sendMessage(to, "diagnostic ping from Liam");
            return sendJson(res, 200, {
              ...base,
              sendProbe: { ok: true, to: maskPhone(to), id: messageId(sent) || "sent" },
            });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              sendProbe: { ok: false, to: maskPhone(to || rawTo), error: String(e && e.message ? e.message : e).slice(0, 400) },
            });
          }
        }
        if (probe === "sendack") {
          // Send a real message and wait for WhatsApp's delivery receipt. A
          // reply that is accepted but never gets past "server" ack is exactly
          // the "she answered but I never got it" symptom.
          const rawTo = url.searchParams.get("to");
          let to = "";
          const wait = Math.min(30000, Math.max(0, Number.parseInt(url.searchParams.get("wait") || "10000", 10) || 10000));
          try {
            to = diagOwnerTarget(rawTo);
            assertRate();
            const sent = await wa.sendMessage(to, "delivery check from Liam");
            const id = messageId(sent);
            let ack = null;
            const deadline = Date.now() + wait;
            while (Date.now() < deadline) {
              ack = outboundAcks.get(id) || null;
              if (ack && (ack.status === "delivered" || ack.status === "read" || ack.status === "played")) break;
              await sleep(500);
            }
            return sendJson(res, 200, {
              ...base,
              sendAckProbe: { ok: true, to: maskPhone(to), id: id || "sent", waitedMs: wait, ack },
            });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              sendAckProbe: { ok: false, to: maskPhone(to), error: String(e && e.message ? e.message : e).slice(0, 400) },
            });
          }
        }
        if (probe === "deliver") {
          // Send the same text to the phone-number JID and to the LID WhatsApp
          // maps that number to, then report which one actually gets a delivery
          // receipt. This pinpoints a LID/PN delivery mismatch.
          const rawTo = url.searchParams.get("to");
          let to = "";
          const wait = Math.min(30000, Math.max(0, Number.parseInt(url.searchParams.get("wait") || "12000", 10) || 12000));
          const out = { to: maskPhone(to), targets: [] };
          try {
            to = diagOwnerTarget(rawTo);
            out.to = maskPhone(to);
            assertRate();
            let lid = "";
            try {
              const list = await sock.onWhatsApp(to);
              const hit = Array.isArray(list) ? (list.find((x) => x && x.exists) || list[0]) : null;
              if (hit) { out.jidKind = jidType(hit.jid); out.exists = !!hit.exists; lid = hit.lid || ""; }
            } catch (e) { out.lookupError = String(e && e.message ? e.message : e).slice(0, 200); }
            const targets = [{ kind: "pn", jid: `${to}@s.whatsapp.net` }];
            if (lid) targets.push({ kind: "lid", jid: lid });
            for (const target of targets) {
              try {
                const sent = await wa.sendMessage(target.jid, `delivery check (${target.kind}) from Liam`);
                target.id = messageId(sent) || "sent";
              } catch (e) { target.error = String(e && e.message ? e.message : e).slice(0, 200); }
            }
            const deadline = Date.now() + wait;
            while (Date.now() < deadline) {
              const done = targets.every((target) => {
                if (!target.id) return true;
                const ack = outboundAcks.get(target.id);
                return ack && ["delivered", "read", "played"].includes(ack.status);
              });
              if (done) break;
              await sleep(500);
            }
            for (const target of targets) target.ack = target.id ? (outboundAcks.get(target.id) || null) : null;
            out.targets = targets;
            return sendJson(res, 200, { ...base, deliverProbe: out });
          } catch (e) {
            out.error = String(e && e.message ? e.message : e).slice(0, 300);
            return sendJson(res, 200, { ...base, deliverProbe: out });
          }
        }
        if (probe === "wire") {
          // The strongest single test: send one message and capture what
          // actually crossed the socket. Frame sizes show whether an encrypted
          // payload was produced, and the ack nodes show what WhatsApp replied.
          const rawTo = url.searchParams.get("to");
          let to = "";
          const wait = Math.min(30000, Math.max(0, Number.parseInt(url.searchParams.get("wait") || "8000", 10) || 8000));
          ackNodeCount = 0;
          ackNodeSamples.length = 0;
          outFrameSizes.length = 0;
          const out = { to: "" };
          try {
            to = diagOwnerTarget(rawTo);
            out.to = maskPhone(to);
            assertRate();
            const sent = await wa.sendMessage(to, "wire check from Liam");
            out.id = messageId(sent) || "sent";
          } catch (e) { out.error = String(e && e.message ? e.message : e).slice(0, 300); }
          await sleep(wait);
          out.ackNodeCount = ackNodeCount;
          out.ackSamples = ackNodeSamples.slice();
          out.frameSizes = outFrameSizes.slice();
          out.framesSent = outFrameSizes.length;
          return sendJson(res, 200, { ...base, wireProbe: out });
        }
        if (probe === "token") {
          // Why an outbound 1:1 message is rejected with 463: is the privacy
          // token present for this contact, and can we read it? Masked, no text.
          const rawTo = url.searchParams.get("to");
          let to = "";
          const out = {};
          try {
            to = diagOwnerTarget(rawTo);
            out.waLogLevel = waLogLevel;
            out.privacyTokenOn1to1 = !!(sock && sock.serverProps && sock.serverProps.privacyTokenOn1to1);
            out.issueToLid = !!(sock && sock.serverProps && sock.serverProps.lidTrustedTokenIssueToLid);
            const keys = sock && sock.authState && sock.authState.keys;
            const lm = sock && sock.signalRepository && sock.signalRepository.lidMapping;
            out.hasLidMapping = !!lm;
            out.hasGetLIDForPN = !!(lm && typeof lm.getLIDForPN === "function");
            out.hasGetPNForLID = !!(lm && typeof lm.getPNForLID === "function");
            // The server's own view of the reach-out time-lock, which is what a
            // 463 (NackCallerReachoutTimelocked) is really about.
            try {
              if (typeof sock.fetchAccountReachoutTimelock === "function") {
                const tl = await sock.fetchAccountReachoutTimelock();
                out.reachoutTimelock = tl ? {
                  isActive: !!tl.isActive,
                  enforcementType: tl.enforcementType || null,
                  endsAt: tl.timeEnforcementEnds ? new Date(tl.timeEnforcementEnds).toISOString() : null,
                } : null;
              }
            } catch (e) { out.reachoutTimelockError = String(e && e.message ? e.message : e).slice(0, 150); }
            try {
              if (typeof sock.fetchNewChatMessageCap === "function") {
                out.newChatCap = await sock.fetchNewChatMessageCap();
              }
            } catch (e) { out.newChatCapError = String(e && e.message ? e.message : e).slice(0, 150); }
            let lid = "";
            try {
              const list = await sock.onWhatsApp(to);
              const hit = Array.isArray(list) ? (list.find((x) => x && x.exists) || list[0]) : null;
              if (hit) lid = hit.lid || "";
            } catch (e) { out.lookupError = String(e && e.message ? e.message : e).slice(0, 150); }
            out.pnKind = "pn";
            out.lidKind = jidType(lid);
            const pnJid = `${to}@s.whatsapp.net`;
            const store = {};
            for (const jid of [pnJid, lid].filter(Boolean)) {
              try {
                const data = await keys.get("tctoken", [jid]);
                const entry = data && data[jid];
                store[jidType(jid)] = entry ? {
                  tokenLen: entry.token ? entry.token.length : 0,
                  timestamp: entry.timestamp || 0,
                  senderTimestamp: entry.senderTimestamp || 0,
                } : null;
              } catch (e) { store[jidType(jid)] = "err:" + String(e && e.message ? e.message : e).slice(0, 80); }
            }
            out.store = store;
            try {
              out.tctokenFiles = fs.readdirSync(SESSION_PROFILE_DIR).filter((f) => f.startsWith("tctoken")).length;
            } catch (e) { out.tctokenFiles = -1; }
          } catch (e) { out.error = String(e && e.message ? e.message : e).slice(0, 200); }
          return sendJson(res, 200, { ...base, tokenProbe: out, tokenLogs: TOKEN_LOGS.slice(-25) });
        }
        if (probe === "account") {
          // Safe, masked view of the linked device so a half-registered or
          // wrong-server session is visible. Never returns the full number.
          const info = {};
          try {
            const me = sock && sock.authState && sock.authState.creds && sock.authState.creds.me;
            const acc = sock && sock.authState && sock.authState.creds && sock.authState.creds.account;
            const uid = sock && sock.user && sock.user.id;
            info.userIdKind = jidType(uid);
            info.userDevice = uid ? (String(uid).split(":")[1] || null) : null;
            info.meIdKind = jidType(me && me.id);
            info.meDevice = me && me.id ? (String(me.id).split(":")[1] || null) : null;
            info.hasLid = !!(sock && sock.user && sock.user.lid);
            info.registered = !!(sock && sock.authState && sock.authState.creds && sock.authState.creds.registered);
            info.platform = (sock && sock.authState && sock.authState.creds && sock.authState.creds.platform) || null;
            info.hasAccountDetails = !!(acc && acc.details);
            info.wsOpen = !!(sock && sock.ws && sock.ws.isOpen);
            info.wsClosed = !!(sock && sock.ws && sock.ws.isClosed);
            info.wsHost = (sock && sock.ws && sock.ws.url)
              ? String(sock.ws.url).replace(/^wss?:\/\//, "").split("/")[0] : null;
          } catch (e) { info.error = String(e && e.message ? e.message : e).slice(0, 200); }
          return sendJson(res, 200, { ...base, accountProbe: info });
        }
        if (probe === "email") {
          try {
            const reply = await withTimeout(
              askLiam("Call the email_read tool with limit 1 and report the exact result. Use no other tool.",
                OWNERS[0], false, "", false, false, { noHistory: true }),
              ASK_TIMEOUT_MS,
              "email probe timed out",
            );
            return sendJson(res, 200, { ...base, emailProbe: String(reply == null ? "" : reply).slice(0, 1000) });
          } catch (e) {
            return sendJson(res, 200, {
              ...base,
              emailProbe: { ok: false, error: String(e && e.message ? e.message : e).slice(0, 600) },
            });
          }
        }
        if (probe === "browser") {
          // Run the agent's real browser_task tool (which now runs Chromium on
          // the VM) and report what it printed. This exercises the exact path
          // the tool uses, without sending a WhatsApp message.
          const target = safeExternalUrl(url.searchParams.get("url") || "https://example.com");
          if (!target) {
            return sendJson(res, 200, {
              ...base,
              browserProbe: { ok: false, error: "only public http(s) URLs are allowed" },
            });
          }
          const result = await runProbeScript(["--browser", target], 150000);
          return sendJson(res, 200, { ...base, browserProbe: { target, ...result } });
        }
        if (probe === "brains") {
          // Per-key provider check. Runs on this host so it sees the real keys.
          // Defaults to MoonMath (the rotating pool); pass &brain=agnes for
          // another provider. Never returns key values, only index + reason.
          const brain = String(url.searchParams.get("brain") || "moonmath").trim();
          const result = await runProbeScript([brain, "--keys", "--json"], 120000);
          return sendJson(res, 200, { ...base, brainProbe: { brain, ...result } });
        }
        if (probe === "voice") {
          // Synthesize a short voice note with the free engine and report the
          // result (mimetype + bytes). No WhatsApp message is sent.
          const text = String(url.searchParams.get("text") || "").trim();
          const result = await runProbeScript(
            text ? ["--voice", text] : ["--voice"], 90000);
          return sendJson(res, 200, { ...base, voiceProbe: result });
        }
        if (probe === "1") {
          try {
            const reply = await withTimeout(
              askLiam("Reply with exactly OK and do not use any tools.", OWNERS[0], false, "", false, false,
                { noHistory: true }),
              ASK_TIMEOUT_MS,
              "probe timed out",
            );
            return sendJson(res, 200, { ...base, probeReply: String(reply == null ? "" : reply).slice(0, 600) });
          } catch (e) {
            // All probes use the same convention: 200 with an error field, so a
            // caller does not need a special case for this one probe.
            return sendJson(res, 200, {
              ...base,
              probeError: String(e && e.message ? e.message : e).slice(0, 600),
            });
          }
        }
        return sendJson(res, 200, base);
      }
      let creds = null;
      try { creds = JSON.parse(fs.readFileSync(CREDS_FILE, "utf8")); } catch (e) { creds = null; }
      sendJson(res, 200, {
        ok: true,
        status: waState,
        detail: waStateDetail,
        lastError: waInitError,
        pairingError,
        pairingRequestedAt: lastPairAt || null,
        authenticatedAt: authAt || null,
        codeAgeSeconds: lastPairCode && lastPairAt ? Math.round((Date.now() - lastPairAt) / 1000) : null,
        code: lastPairCode ? `${lastPairCode.slice(0, 4)}-${lastPairCode.slice(4)}` : null,
        linkHandshakeActive: linkHandshakeActive(),
        socketOpen: !!(sock && registered),
        readyForPairing: !!sockReadyForPairing,
        registered: !!(creds && creds.registered),
        socketUserIdKind: jidType(socketUserId()),
        socketUserId: maskPhone(socketUserId()),
        reconnectScheduled: !!reconnectTimer,
        waVersion: waVersion ? waVersion.join(".") : null,
        startedAt: STARTED_AT,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        memoryMiB: containerMemoryMiB(),
        memory: containerMemoryInfo(),
        linkedMarker: hasLinkMarker(),
        marker: maskedLinkMarker(readLinkMarker()),
        credsPresent: profileHasCredentials(),
        sessionFiles: (() => {
          try { return fs.readdirSync(SESSION_PROFILE_DIR).length; } catch (e) { return 0; }
        })(),
        events: waEvents.slice(-15),
      });
      return;
    }
    if (pathname === "/qr") {
      const auth = pairAuth(req, url);
      if (!auth.ok) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1><p>Provide the pairing token via a secure pairing session or Authorization header.</p>"));
      if (auth.via === "query") {
        return sendHtml(res, 302, "", { Location: "/qr", "Set-Cookie": pairCookieHeader(req) });
      }
      return sendHtml(res, 200, pageShell("Liam pairing",
        `<h1>Liam uses a phone code</h1>` +
        `<p>QR linking has been removed. Open the <a href="/pair">pairing page</a> ` +
        `and press the button to get an 8-character code.</p>` +
        (waState === "ready" ? `<p>Liam is already linked.</p>` : "")));
    }
    if (pathname === "/pair") {
      const auth = pairAuth(req, url);
      if (!auth.ok) {
        // Allow entering the token securely in the page (no token in URL).
        return sendHtml(res, 403, pairPage({ needToken: true, error: "Enter the pairing token to continue." }));
      }
      if (auth.via === "query") {
        const phone = url.searchParams.get("phone") || "";
        const loc = "/pair" + (phone ? `?phone=${encodeURIComponent(phone)}` : "");
        return sendHtml(res, 302, "", { Location: loc, "Set-Cookie": pairCookieHeader(req) });
      }
      const phone = url.searchParams.get("phone") || "";
      // Never create a code just because the page was opened or reloaded. That
      // silently burned another request against WhatsApp's rate limit and handed
      // out codes nobody typed. Only the button (POST /pair) asks for a code.
      return sendHtml(res, 200, pairPage({ phone }));
    }
  }

  if (req.method === "POST" && pathname === "/pair") {
    (async () => {
      let bodyToken = "";
      try {
        const raw = await readBody(req, 8 * 1024);
        let data = {};
        const type = String(req.headers["content-type"] || "");
        if (/application\/json/i.test(type)) data = JSON.parse(raw || "{}");
        else data = Object.fromEntries(new URLSearchParams(raw || ""));
        bodyToken = String(data.token || "");
        const auth = pairAuth(req, url, bodyToken);
        if (!auth.ok) return sendHtml(res, 403, pairPage({ needToken: true, error: "Invalid or missing pairing token." }));
        // Cookie-authenticated browser posts must come from our own page. Token
        // clients (no Origin/Referer) are unaffected.
        if (!sameOriginRequest(req)) return sendHtml(res, 403, pairPage({ error: "Invalid request origin." }));
        const phone = String(data.phone || "");
        const code = await requestPairing(phone);
        const headers = (auth.via === "body" || auth.via === "query") ? { "Set-Cookie": pairCookieHeader(req) } : {};
        // Always render on clean URL context; token never echoed into page/URL.
        sendHtml(res, 200, pairPage({ phone, code, requestedAt: lastPairAt }), headers);
      } catch (e) {
        // The body was already read above, so reuse its token instead of
        // re-reading the request (which is not possible) or ignoring it.
        const auth = pairAuth(req, url, bodyToken);
        if (!auth.ok) return sendHtml(res, 403, pairPage({ needToken: true, error: "Invalid or missing pairing token." }));
        const headers = (auth.via === "body" || auth.via === "query") ? { "Set-Cookie": pairCookieHeader(req) } : {};
        sendHtml(res, 400, pairPage({ error: e instanceof BadRequest ? e.message : "pairing failed" }), headers);
      }
    })();
    return;
  }

  // Allow tokened POST for state-changing pairing actions (best practice over GET).
  if (req.method === "POST" && pathname === "/cancelpair") {
    (async () => {
      let bodyToken = "";
      try {
        const raw = await readBody(req, 8 * 1024);
        let data = {};
        const type = String(req.headers["content-type"] || "");
        if (/application\/json/i.test(type)) data = JSON.parse(raw || "{}");
        else data = Object.fromEntries(new URLSearchParams(raw || ""));
        bodyToken = String(data.token || "");
        const auth = pairAuth(req, url, bodyToken);
        if (!auth.ok) return sendJson(res, 403, { ok: false, msg: "forbidden" });
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, msg: "invalid origin" });
        await Promise.race([
          cancelPairing(),
          sleep(20000).then(() => { throw new Error("cancel timed out"); }),
        ]);
        const headers = (auth.via === "body" || auth.via === "query") ? { "Set-Cookie": pairCookieHeader(req) } : {};
        sendJson(res, 200, { ok: true, ...statusPayload() }, headers);
      } catch (e) {
        sendJson(res, 500, { ok: false, msg: String(e && e.message ? e.message : e) });
      }
    })();
    return;
  }
  if (req.method === "POST" && pathname === "/reset") {
    (async () => {
      let bodyToken = "";
      try {
        const raw = await readBody(req, 8 * 1024);
        let data = {};
        const type = String(req.headers["content-type"] || "");
        if (/application\/json/i.test(type)) data = JSON.parse(raw || "{}");
        else data = Object.fromEntries(new URLSearchParams(raw || ""));
        bodyToken = String(data.token || "");
        const auth = pairAuth(req, url, bodyToken);
        if (!auth.ok) return sendJson(res, 403, { ok: false, msg: "forbidden" });
        if (!sameOriginRequest(req)) return sendJson(res, 403, { ok: false, msg: "invalid origin" });
        if (waState === "ready") return sendJson(res, 409, { ok: false, msg: "already linked; a reset is not needed" });
        await Promise.race([
          resetWhatsApp("manual reset"),
          sleep(180000).then(() => { throw new Error("reset timed out"); }),
        ]);
        const headers = (auth.via === "body" || auth.via === "query") ? { "Set-Cookie": pairCookieHeader(req) } : {};
        sendJson(res, 200, { ok: true, ...statusPayload() }, headers);
      } catch (e) {
        sendJson(res, 500, { ok: false, msg: String(e && e.message ? e.message : e) });
      }
    })();
    return;
  }

  // Owner dashboard. The browser authenticates with the pairing session cookie;
  // LIAM_OWNER_TOKEN is never sent to it. Mutations are JSON POSTs guarded by
  // sameOriginRequest, matching the existing BR-3/BR-18 rule.
  if (req.method === "POST" && pathname === "/dashboard/login") {
    (async () => {
      try {
        const raw = await readBody(req, 8 * 1024);
        const type = String(req.headers["content-type"] || "");
        const data = /application\/json/i.test(type)
          ? JSON.parse(raw || "{}")
          : Object.fromEntries(new URLSearchParams(raw || ""));
        if (!sameOriginRequest(req)) {
          return sendHtml(res, 403, dashboardLoginPage("invalid request origin"), dashboardCsp(""));
        }
        if (!pairTokenOk(String(data.token || ""))) {
          // Slow down guessing without making a legitimate retry painful.
          await sleep(350);
          return sendHtml(res, 403, dashboardLoginPage("invalid token"), dashboardCsp(""));
        }
        return sendHtml(res, 303, "", { Location: "/dashboard", "Set-Cookie": pairCookieHeader(req) });
      } catch (e) {
        return sendHtml(res, 400, dashboardLoginPage("could not read the request"), dashboardCsp(""));
      }
    })();
    return;
  }

  if (req.method === "POST" && pathname === "/dashboard/action") {
    return dashboardPost(req, res, url, async (data) => {
      const action = String(data.action || "");
      if (!["stop", "stop_agent", "offline", "start_agent"].includes(action)) {
        throw new BadRequest("unknown action");
      }
      console.log("info: dashboard action", action);
      const msg = await handleAction({ action, sender: OWNERS[0] });
      return { msg: String(msg == null ? "" : msg) };
    });
  }

  if (req.method === "POST" && pathname === "/dashboard/exec") {
    return dashboardPost(req, res, url, async (data) => {
      const command = String(data.command || "").trim();
      if (!command) throw new BadRequest("command is empty");
      if (command.length > 8000) throw new BadRequest("command is too long");
      const timeout = Math.min(3600, Math.max(1, Number.parseInt(data.timeout, 10) || 120));
      // Never log the command itself: it may contain a secret.
      console.log("info: dashboard exec (" + command.length + " chars)");
      const output = await instaboxExec(command, timeout, String(data.cwd || "").slice(0, 500));
      return { output: String(output == null ? "" : output) };
    });
  }

  if (req.method === "POST" && pathname === "/dashboard/pair") {
    return dashboardPost(req, res, url, async (data) => {
      const phone = String(data.phone || "").replace(/\D/g, "");
      console.log("info: dashboard pairing code requested");
      const code = await requestPairing(phone);
      return { code: formatPairCode(code), requestedAt: lastPairAt || Date.now() };
    });
  }

  // Any other GET (including "/") is not a tool call.
  if (req.method !== "POST") {
    req.resume();
    return sendJson(res, 405, { ok: false, msg: "method not allowed" });
  }

  // The tool endpoint is loopback-only and token-authenticated. Host/Origin
  // checks add defence in depth against DNS rebinding and browser CSRF.
  if (!isLoopback(req.socket.remoteAddress)) {
    req.resume();
    return sendJson(res, 403, { ok: false, msg: "forbidden" });
  }
  if (!allowedHost(String(req.headers.host || ""))) {
    req.resume();
    return sendJson(res, 403, { ok: false, msg: "forbidden" });
  }
  if (req.headers.origin) {
    req.resume();
    return sendJson(res, 403, { ok: false, msg: "forbidden" });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
    req.resume();
    return sendJson(res, 415, { ok: false, msg: "content-type must be application/json" });
  }
  const toolAuthed = authorized(req);
  const ownerAuthed = authorizedWith(req, OWNER_TOKEN);
  if (!toolAuthed && !ownerAuthed) {
    req.resume();
    return sendJson(res, 401, { ok: false, msg: "unauthorized" });
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    return sendJson(res, 413, { ok: false, msg: "request too large" });
  }

  const bodyParts = [];
  let bodySize = 0;
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bodySize += buf.length;
    if (bodySize > MAX_BODY) {
      tooBig = true;
      sendJson(res, 413, { ok: false, msg: "request too large" });
      return;
    }
    bodyParts.push(buf);
  });
  req.on("end", async () => {
    if (tooBig) return;
    const body = Buffer.concat(bodyParts).toString("utf8");
    let data;
    try { data = JSON.parse(body || "{}"); }
    catch (e) { return sendJson(res, 400, { ok: false, msg: "invalid request" }); }
    // The loopback token can request approvals and act as the person whose turn
    // it is carrying. It cannot claim to be an owner: owner-scoped actions need
    // the separate token the bridge gave only to its own agent process.
    if (claimsOwner(data) && !ownerAuthed) {
      return sendJson(res, 403, { ok: false, msg: "owner token required" });
    }
    try {
      const message = await handleAction(data);
      sendJson(res, 200, { ok: true, msg: message });
    } catch (e) {
      if (e instanceof BadRequest) {
        sendJson(res, 400, { ok: false, msg: e.message });
      } else {
        console.log("\n💀 TOOL ACTION FAILED:", data && data.action, String(e));
        sendJson(res, 500, { ok: false, msg: "the WhatsApp action failed - try again" });
      }
    }
  });
  req.on("error", () => {
    if (!res.writableEnded) sendJson(res, 400, { ok: false, msg: "invalid request" });
  });
});

server.on("clientError", (err, socket) => {
  try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch (e) {}
});

const HOST = process.env.HOST || "0.0.0.0";
server.listen(PORT, HOST, () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PORT;
  console.log(`⚙️ Liam's tool endpoint is live on :${port} (HOST=${HOST})`);
  const base = PUBLIC_URL || `http://127.0.0.1:${port}`;
  // Do not print the full pairing token to logs (shared log aggregators may
  // capture it). Use LIAM_PAIR_TOKEN / the persisted pair_token file to build
  // the full /pair?token=... URL when needed.
  const masked = PAIR_TOKEN.length > 8 ? `${PAIR_TOKEN.slice(0, 4)}…${PAIR_TOKEN.slice(-4)}` : "(set)";
  console.log(`🔗 Pairing page: ${base}/pair?token=<redacted> (token ${masked})`);
});

async function initializeWhatsApp(reason) {
  if (waInitPromise) return waInitPromise;
  waInitPromise = (async () => {
    try {
      setWaState(waState === "ready" ? "ready" : (waState === "needs_qr" ? "needs_qr" : "starting"),
        reason || "starting WhatsApp");
      await connectSocket(reason);
      waInitError = "";
    } catch (e) {
      const msg = String(e && e.stack ? e.stack : e);
      waInitError = msg;
      console.log("\n💀 WHATSAPP INIT FAILED:", msg);
      // A socket cannot recover from a failed creation. Try again shortly
      // instead of sitting in "error" and needing a manual reset.
      setWaState("error", "WhatsApp connection failed");
      scheduleReconnect("init failed", 10000);
    } finally {
      waInitPromise = null;
    }
  })();
  return waInitPromise;
}

async function boot() {
  setWaState("restoring", "restoring state from Supabase (if configured)");
  // Restore to completion before a socket starts. Abandoning a restore on a
  // timer would let it swap the login files underneath a running socket, so the
  // internal fetch and tar timeouts are the only limits.
  try {
    const dbRes = await sync.restoreDb(DATA_DIR);
    if (dbRes && (dbRes.timeout || dbRes.error)) {
      console.log("warn: db restore did not complete; continuing");
    }
    const sessRes = await sync.restoreSession(DATA_DIR, SESSION_DIR);
    if (sessRes && (sessRes.timeout || sessRes.error)) {
      console.log("warn: session restore did not complete; continuing");
    }
    const removed = sync.sanitizeChromeLocks(SESSION_DIR);
    if (removed) console.log(`🔧 Sanitized ${removed} stale lock file(s) before init`);
  } catch (e) {
    console.log("warn: restore phase failed:", String(e));
  }

  // Held replies, group permissions and pending approvals come back too, so a
  // redeploy during a WhatsApp send-block does not lose them.
  try { await loadBridgeState(); } catch (e) { console.log("warn: bridge state restore failed:", String(e)); }

  const markerPresent = hasLinkMarker();
  const credsPresent = profileHasCredentials();
  if (!markerPresent || !credsPresent) {
    // No completed login, or the marker survived but creds.json did not (a
    // failed restore). Baileys writes creds.json before the phone confirms the
    // code, so either file alone cannot prove that WhatsApp is linked. Start
    // clean so a half-finished link cannot poison the next attempt.
    const removed = fs.existsSync(SESSION_PROFILE_DIR);
    if (removed) {
      try { fs.rmSync(SESSION_PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
    }
    if (markerPresent && !credsPresent) clearLinkMarker();
    removeQrFile();
    console.log(removed
      ? "info: discarded a half-finished WhatsApp login - starting clean"
      : "info: no linked WhatsApp login yet - starting clean");
    setWaState("needs_qr", "no saved login - press the button once on the pairing page");
  } else {
    const marker = readLinkMarker();
    if (marker && marker.wid) console.log(`info: restoring linked WhatsApp session (${maskPhone(marker.wid)})`);
  }
  // Resolve the interpreter off the hot path. A synchronous probe here used to
  // block Baileys long enough to starve its handshake and keepalive.
  void resolvePythonBinAsync();
  await initializeWhatsApp("startup");
  startMemoryGuard();
  startKeepAlive();
  startReachoutWatch();
}

// Render sends SIGTERM before stopping a free instance. Save the profile and
// memory first so the next boot does not depend on the last periodic backup.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  // Capture readiness before destroying the client. An unlinked profile must
  // not overwrite the last good session in Supabase.
  const sessionReady = waState === "ready";
  console.log(`\n⏹️ ${signal} received — saving state before shutdown`);
  try { stopAgent(); } catch (e) {}
  try { sync.stopPeriodicBackup(); } catch (e) {}
  const deadline = setTimeout(() => {
    console.log("warn: shutdown backup timed out");
    process.exit(0);
  }, 25000);
  if (typeof deadline.unref === "function") deadline.unref();
  try {
    await Promise.race([closeSocket("shutdown"), sleep(5000)]);
  } catch (e) { console.log("warn: WhatsApp shutdown failed:", String(e)); }
  try { await sync.backupNow(DATA_DIR, SESSION_DIR, DATA_DIR, { session: sessionReady }); }
  catch (e) { console.log("warn: shutdown backup failed:", String(e)); }
  // Push the small state (held replies, permissions) before exiting, so a
  // redeploy during a send-block does not drop what we are still holding.
  try { saveBridgeStateLocal(); } catch (e) {}
  try {
    if (sync.uploadState) await sync.uploadState(DATA_DIR, BRIDGE_STATE_OBJECT, bridgeStateSnapshot());
  } catch (e) {}
  clearTimeout(deadline);
  process.exit(0);
}
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { shutdown(signal).catch(() => process.exit(0)); });
}

if (require.main === module) {
  boot().catch((e) => {
    console.log("💀 boot failed:", String(e));
    setWaState("error", "boot failed");
  });
}

module.exports = {
  server, getSock: () => sock, wa, sweepTimer, outboundLog, handleAction,
  normalizeRecipient, normalizeGroup, isGroupJid, assertAllowed, assertOutbox, audioMime, authorized,
  sync, pythonBin, sanitizeChromeLocks: sync.sanitizeChromeLocks,
  statusPayload, TEMP, tempDecision, sweepTemp, _setState: setWaState,
  stopAgent, initializeWhatsApp, hasSessionData, requestPairing, instaboxExec,
  setAgentOffline, isAgentOffline: () => agentOffline, dashboardStatePayload,
  pendingPerms, pendingTools, PAIR_TOKEN, ownerIdsInGroup, sendApprovalPrompt,
  createToolApproval, executeToolApproval, handleApprovalCommand, createPermissionRequest,
  dmAllowed, setDmOpen, rememberKnownMember, knownMembers,
  cancelPairing, resetWhatsApp, connectSocket, closeSocket, handleIncomingMessage,
  messageId, jidForSend, socketUserId, friendlyWaError,
  SERVER_DOWN_TEXT, startKeepAlive, markReadAndTyping, stopTyping,
  pnFromParticipant, rememberLidContacts, lidContacts, resolvePhone,
  messageText, mediaPlaceholder, displayText,
  OWNER_TOKEN, sameOriginRequest, diagOwnerTarget, safeExternalUrl, isPrivateAddress,
  loadBridgeState, saveBridgeStateLocal, applyBridgeState, bridgeStateSnapshot,
  scheduleBridgeStateSave, heldReplies, deliverProgress,
};
