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
const crypto = require("crypto");
let sync;
try { sync = require("./supabase_sync"); }
catch (e) { sync = { restoreSession: async()=>({restored:false}), restoreDb: async()=>({restored:false}), backupSession: async()=>({ok:false}), backupDb: async()=>({ok:false}), backupNow: async()=>({ok:false}), sanitizeChromeLocks: ()=>0, startPeriodicBackup: ()=>null, stopPeriodicBackup: ()=>{}, configured: ()=>false }; }

process.on("unhandledRejection", (r) => {
  noteWaEvent("unhandledRejection", String(r && r.message ? r.message : r).slice(0, 180));
  console.log("\n💀 UNHANDLED REJECTION:", String(r && r.stack ? r.stack : r));
});
process.on("uncaughtException", (e) => {
  noteWaEvent("uncaughtException", String(e && e.message ? e.message : e).slice(0, 180));
  console.log("\n💀 UNCAUGHT EXCEPTION:", String(e && e.stack ? e.stack : e));
});

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
const BRAIN_FILE = path.join(DATA_DIR, "brain_state");
const QR_FILE = path.join(DATA_DIR, "qr.png");
const DM_OPEN_FILE = path.join(DATA_DIR, "dm_open");

const MAX_BODY = 64 * 1024;
const MAX_MEDIA = 25 * 1024 * 1024;
const OUTBOUND_WINDOW = 60 * 1000;
const OUTBOUND_MAX = 20;
const PERMISSION_TTL_MS = Math.max(60_000, Number.parseInt(process.env.LIAM_GROUP_PERMISSION_MS || String(3 * 60 * 60 * 1000), 10));
const PENDING_TTL_MS = Math.max(60_000, Number.parseInt(process.env.LIAM_PENDING_TTL_MS || String(30 * 60 * 1000), 10));
const TOOL_APPROVAL_TTL_MS = Math.max(60_000, Number.parseInt(process.env.LIAM_TOOL_APPROVAL_MS || String(10 * 60 * 1000), 10));
// Minimum gap between two pairing-code requests. WhatsApp blocks a number that
// asks repeatedly, and each request restarts that block.
const PAIRING_COOLDOWN_MS = Math.max(60_000, Number.parseInt(process.env.LIAM_PAIRING_COOLDOWN_MS || "120000", 10));
const MAX_PENDING = 40;

function resolvePort() {
  const raw = process.env.PORT || process.env.LIAM_PORT || "5678";
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
const knownMembers = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(KNOWN_MEMBERS_FILE, "utf8"));
  if (Array.isArray(raw)) raw.map(bareId).filter((p) => /^\d{6,20}$/.test(p)).forEach((p) => knownMembers.add(p));
} catch (e) {}
function saveKnownMembers() {
  try {
    fs.writeFileSync(KNOWN_MEMBERS_FILE, JSON.stringify([...knownMembers].slice(-5000)), { mode: 0o600 });
  } catch (e) {}
}
function rememberKnownMember(phone) {
  const p = bareId(phone);
  if (!/^\d{6,20}$/.test(p) || knownMembers.has(p)) return;
  knownMembers.add(p);
  saveKnownMembers();
}

function copyLegacy(src, dest, mode = 0o600) {
  try {
    if (fs.existsSync(dest) || !fs.existsSync(src)) return;
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, mode); } catch (e) {}
    fs.rmSync(src, { force: true });
  } catch (e) { console.log("⚠️ could not migrate " + src + ": " + String(e)); }
}

// Move control files and session data out of the project directory.
copyLegacy(path.join(BASE_DIR, ".brain_state"), BRAIN_FILE);
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
const BOT_PHONE = String(process.env.LIAM_BOT_PHONE || "447881161023").replace(/\D/g, "");

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
  try { return fs.existsSync(CREDS_FILE); } catch (e) { return false; }
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
  if (process.env.LIAM_DM_OPEN != null) return String(process.env.LIAM_DM_OPEN || "0") === "1";
  try { return fs.readFileSync(DM_OPEN_FILE, "utf8").trim() === "1"; } catch (e) { return false; }
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
const ASK_TIMEOUT_MS = Math.max(15000, Number.parseInt(process.env.LIAM_ASK_TIMEOUT_MS || "180000", 10));
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
let lastOutboundAt = 0;
let lastAgentRequestAt = 0;
let lastAgentReplyAt = 0;
let lastAgentError = "";
let agentStderrTail = "";
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

function pythonBin() {
  const candidates = [];
  if (process.env.LIAM_PYTHON) candidates.push(process.env.LIAM_PYTHON);
  candidates.push("python3", "python");
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", timeout: 8000 });
      if (r.status === 0 && String(r.stdout || "").trim()) return bin;
    } catch (e) {}
  }
  return process.platform === "win32" ? "python" : "python3";
}

function startAgent() {
  // Tests drive the HTTP surface without spawning Python.
  if (String(process.env.LIAM_DISABLE_AGENT || "") === "1") return null;
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
      if (Object.prototype.hasOwnProperty.call(msg, "reply")) {
        if (!agentPending) { console.log("[agent] stale reply ignored"); continue; }
        const p = agentPending; agentPending = null;
        try { clearTimeout(p.timeout); } catch (e) {}
        lastAgentReplyAt = Date.now();
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
  });
  proc.on("error", (e) => {
    if (agentProc === proc) agentProc = null;
    console.log("\n💀 AGENT SPAWN ERROR:", String(e));
    failPending(e);
  });
  return proc;
}

function stopAgent() {
  const proc = agentProc;
  agentProc = null;
  if (agentPending) { const p = agentPending; agentPending = null; try { clearTimeout(p.timeout); } catch (e) {} p.reject(new Error("agent stopped")); }
  if (!proc) return;
  try { proc.stdin.end(); } catch (e) {}
  if (process.platform === "win32" && proc.pid) {
    try { spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" }); return; } catch (e) {}
  }
  try { proc.kill(); } catch (e) {}
}

const LID_MAP_FILE = path.join(DATA_DIR, "lid_map.json");
let lidCache = new Map();
try { const raw = JSON.parse(fs.readFileSync(LID_MAP_FILE, "utf8")); for (const [k,v] of Object.entries(raw)) lidCache.set(k,v); } catch (e) {}
function saveLidMap() { try { fs.writeFileSync(LID_MAP_FILE, JSON.stringify(Object.fromEntries(lidCache)), { mode: 0o600 }); } catch (e) {} }

// WhatsApp now hides phone numbers behind LIDs in many chats. Permissions are
// keyed by phone number, so keep the LID -> phone mapping learned from contact
// updates and group metadata.
const lidContacts = new Map();

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
    const lid = String(contact.lid || "");
    const phone = barePhone(contact.id || contact.jid || "");
    if (!lid.includes("@lid") || !phone) continue;
    const lidBare = bareId(lid);
    if (!lidBare || lidContacts.has(lidBare)) continue;
    lidContacts.set(lidBare, phone);
    lidCache.set(lidBare, phone);
    changed = true;
  }
  if (changed) saveLidMap();
}

// Group participants carry both identities. Prefer the phone-number one.
function pnFromParticipant(participant) {
  if (!participant) return "";
  for (const candidate of [participant.phoneNumber, participant.id, participant.lid]) {
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

async function resolvePhone(id, message) {
  const raw = String(id || "");
  if (!raw) return null;
  if (!isLidJid(raw)) return barePhone(raw) || null;
  const base = bareId(raw);
  const key = message && message.key ? message.key : {};

  // The message key usually carries the phone-number alias.
  for (const candidate of [key.participantPn, key.senderPn, key.remoteJidAlt]) {
    const phone = barePhone(candidate);
    if (phone) return phone;
  }
  if (lidCache.has(base)) return lidCache.get(base);
  if (lidContacts.has(base)) {
    const phone = lidContacts.get(base);
    lidCache.set(base, phone);
    saveLidMap();
    return phone;
  }

  // Group metadata pairs each LID with its phone-number JID.
  const chatJid = key.remoteJid || "";
  if (chatJid && isJidGroup(chatJid) && sock) {
    try {
      const meta = await sock.groupMetadata(chatJid);
      for (const participant of (meta && meta.participants) || []) {
        const lid = participant && participant.lid ? bareId(participant.lid) : "";
        const phone = pnFromParticipant(participant);
        if (!phone) continue;
        if (lid === base || bareId(participant.id) === base || phone === base) {
          lidCache.set(base, phone);
          saveLidMap();
          return phone;
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
      if (phone) { lidCache.set(base, phone); saveLidMap(); return phone; }
    }
  } catch (e) {}

  // Last resort: ask WhatsApp about this identity.
  try {
    const list = await sock.onWhatsApp(raw);
    if (Array.isArray(list)) {
      for (const hit of list) {
        const phone = barePhone(hit && (hit.jid || hit.pn || hit.phoneNumber));
        if (phone) { lidCache.set(base, phone); saveLidMap(); return phone; }
      }
    }
  } catch (e) { console.log("🔍 LID lookup failed:", String(e && e.message ? e.message : e)); }
  console.log("warn: could not map a LID sender to a phone number:", base);
  return null;
}

// ---------------------------------------------------------------------------
// Thin adapter so the rest of the bridge does not care that Baileys replaced
// whatsapp-web.js. Targets are phone-number JIDs; groups and LIDs pass through.
// ---------------------------------------------------------------------------
function jidForSend(value) {
  const raw = String(value || "").trim();
  if (!raw) throw new Error("missing recipient");
  if (/@(?:g\.us|lid|broadcast|newsletter|s\.whatsapp\.net)$/i.test(raw)) return raw;
  if (/@c\.us$/i.test(raw)) return raw.replace(/@c\.us$/i, "@s.whatsapp.net");
  if (/^\d{6,20}(?::\d+)?$/.test(raw)) return raw.split(":")[0] + "@s.whatsapp.net";
  return raw;
}

function messageId(sent) {
  try { return sent && sent.key && sent.key.id ? String(sent.key.id) : null; } catch (e) { return null; }
}

const wa = {
  get connected() { return !!(sock && registered); },
  async sendMessage(jid, content, options) {
    if (!sock) throw new Error("WhatsApp is not connected");
    // Baileys requires an object with `text`; unlike whatsapp-web.js it throws
    // "Cannot use 'in' operator to search for 'text'" when given a plain string.
    const payload = typeof content === "string" ? { text: content } : content;
    const sent = await sock.sendMessage(jidForSend(jid), payload, options);
    lastOutboundAt = Date.now();
    return sent;
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

function askLiam(user, phone, isGroup, groupJid, mentioned, replyTo) {
  lastAgentRequestAt = Date.now();
  lastAgentError = "";
  const job = () => new Promise((resolve, reject) => {
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
    agentPending = { resolve, reject, timeout, id };
    const payload = JSON.stringify({
      u: String(user == null ? "" : user),
      s: String(phone == null ? "" : phone),
      g: !!isGroup,
      j: groupJid || "",
      m: !!mentioned,
      r: !!replyTo
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
  for (const jid of Object.keys(TEMP)) {
    for (const n of Object.keys(TEMP[jid] || {})) {
      const stamp = TEMP[jid][n];
      if (!stamp || now - Math.abs(stamp) > PERMISSION_TTL_MS) delete TEMP[jid][n];
    }
    if (TEMP[jid] && !Object.keys(TEMP[jid]).length) delete TEMP[jid];
  }
  for (const [id, p] of pendingPerms) if (!p || now - p.ts > PENDING_TTL_MS) pendingPerms.delete(id);
  for (const [id, p] of pendingTools) if (!p || now - p.ts > TOOL_APPROVAL_TTL_MS) pendingTools.delete(id);
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
  // Group asks stay in the group. Never DM the owners for something that
  // happened in a group: the owner replies in the group and everyone there can
  // see that Liam is waiting for a yes/no.
  if (groupJid) {
    const owners = await ownerIdsInGroup(groupJid);
    const tags = owners.map((o) => "@" + o).join(" ");
    const body = tags ? `${tags} ${text}`.trim() : text;
    try {
      await wa.sendMessage(groupJid, body, owners.length
        ? { mentions: owners.map((o) => o + "@s.whatsapp.net") }
        : undefined);
      return true;
    } catch (e) {
      console.log("warn: group approval prompt failed:", String(e));
      return false;
    }
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
    "Owner approval needed (one-time, valid 10 minutes).",
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
  return p;
}

function permissionPromptText(p) {
  return [
    "Group permission needed (3 hours).",
    `${p.phone} wants Liam to reply in this group.`,
    `Request ${p.id}.`,
    `Reply: yes ${p.id} / no ${p.id}`,
  ].join("\n");
}

async function createPermissionRequest(jid, phone, text, quoted) {
  sweepTemp();
  const bare = bareId(phone);
  for (const p of pendingPerms.values()) {
    if (p.jid === jid && p.phone === bare) {
      p.text = String(text || "").slice(0, 2000);
      p.quoted = quoted || p.quoted;
      p.ts = Date.now();
      return p;
    }
  }
  const id = makeId("p");
  const p = {
    id, jid, phone: bare,
    text: String(text || "").slice(0, 2000),
    quoted: quoted || null,
    ts: Date.now(),
  };
  pendingPerms.set(id, p);
  trimPending(pendingPerms);
  const sent = await sendApprovalPrompt(permissionPromptText(p), jid);
  if (!sent) {
    pendingPerms.delete(id);
    return null;
  }
  return p;
}

async function executeToolApproval(id, ownerChat) {
  const p = pendingTools.get(id);
  if (!p) return "that approval request has expired or was already used";
  pendingTools.delete(id);
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
      try { await wa.sendMessage(chat, `🚫 denied ${toolId} (${p ? p.action : "tool"}).`); } catch (e) {}
    }
    return true;
  }

  let permId = null;
  if (wanted && pendingPerms.has(wanted)) permId = wanted;
  else if (!wanted && !pendingTools.size) {
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
      TEMP[p.jid] = TEMP[p.jid] || {};
      TEMP[p.jid][p.phone] = -Date.now();
      try { await wa.sendMessage(p.jid, `okay, I won't reply to ${p.phone} in this group.`); } catch (e) {}
      if (chat !== p.jid) { try { await wa.sendMessage(chat, `okay — denied ${p.id}.`); } catch (e) {} }
      return true;
    }
    TEMP[p.jid] = TEMP[p.jid] || {};
    TEMP[p.jid][p.phone] = Date.now();
    try { await wa.sendMessage(p.jid, `okay, I'll reply to ${p.phone} for the next 3 hours.`); } catch (e) {}
    try {
      const reply = await askLiam(p.text, p.phone, true, p.jid, true, false);
      const sent = await sendLong(p.jid, reply, p.quoted ? { quoted: p.quoted } : undefined);
      rememberLiamMessage(p.jid, messageId(sent));
    } catch (e) { console.log("warn: approved reply failed:", String(e)); }
    if (chat !== p.jid) { try { await wa.sendMessage(chat, `okay — allowed ${p.phone} for 3 hours.`); } catch (e) {} }
    return true;
  }

  if (wanted) {
    const prefix = wanted[0];
    if (prefix === "t" || prefix === "p") {
      try { await wa.sendMessage(chat, `I don't see ${wanted} — it expired or was already used.`); } catch (e) {}
      return true;
    }
  }
  if (!wanted && pendingTools.size) {
    try {
      await wa.sendMessage(chat, "Tool approvals need the request id — reply `yes t…` or `no t…`.");
    } catch (e) {}
    return true;
  }
  return false;
}

// Baileys logs every protocol frame at debug level. On Render's free log plan
// that is noise, so drop everything and print only the events Liam cares about.
function baileysLogger() {
  const noop = () => {};
  const logger = {
    level: "silent",
    trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => logger,
  };
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
  // Start backups only after WhatsApp is actually linked. Before this point
  // the profile is disposable and must never replace a good cloud copy.
  sync.startPeriodicBackup(DATA_DIR, SESSION_DIR, DATA_DIR);
  // Archive immediately, so a free Render instance that spins down soon after
  // pairing still leaves a restorable session in Supabase.
  setTimeout(() => {
    try {
      Promise.resolve(sync.backupNow(DATA_DIR, SESSION_DIR, DATA_DIR))
        .then((r) => { if (!r || !r.ok) console.log("warn: immediate backup did not complete"); })
        .catch((e) => console.log("warn: immediate backup failed:", String(e)));
    } catch (e) {}
  }, 3000);
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
  sockReadyForPairing = false;
  registered = false;
  readyHandled = false;
  const reason = String(detail || "").split("\n")[0].slice(0, 200);
  noteWaEvent("closed", `${status || "?"} ${reason}`);
  console.log(`\n⚠️ WhatsApp connection closed (${status || "unknown"})${reason ? ": " + reason : ""}`);
  stopAgent();

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
    setWaState("disconnected", "WhatsApp is limiting this number; waiting 5 minutes");
    noteWaEvent("rate_limited", reason);
    scheduleReconnect("rate limited", 5 * 60 * 1000);
    return;
  }

  const now = Date.now();
  if (!closeWindowStart || now - closeWindowStart > 5 * 60 * 1000) {
    closeWindowStart = now;
    closeCount = 0;
  }
  closeCount += 1;
  if (closeCount > 3) {
    setWaState("error", "WhatsApp keeps disconnecting");
    autoReset("WhatsApp keeps disconnecting");
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
  sock = null;
  connecting = false;
  sockReadyForPairing = false;
  registered = false;
  if (!current) return;
  try { current.ev.removeAllListeners("connection.update"); } catch (e) {}
  try { current.ev.removeAllListeners("creds.update"); } catch (e) {}
  try { current.end(new Error(reason || "closing")); } catch (e) {}
  // Give the websocket a moment to send the close frame; it is not required for
  // correctness, but avoids reconnecting while the old socket is still open.
  await sleep(150);
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
      keepAliveIntervalMs: 30000,
      defaultQueryTimeoutMs: 60000,
      retryRequestDelayMs: 2000,
    });
    sock = socket;
    readyHandled = false;
    registered = false;
    sockReadyForPairing = false;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", (update) => onConnectionUpdate(socket, update));
    socket.ev.on("messages.upsert", (event) => {
      if (!event || event.type !== "notify" || !Array.isArray(event.messages)) return;
      for (const message of event.messages) handleIncomingMessage(message);
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

async function sendLong(to, text, options) {
  let last = null;
  let first = true;
  for (const chunk of splitMessage(text)) {
    if (!chunk.trim()) continue;
    last = await wa.sendMessage(to, chunk, first ? options : undefined);
    first = false;
  }
  return last;
}

async function ownerPresentInGroup(jid) {
  return (await ownerIdsInGroup(jid)).length > 0;
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

function messageText(content, type) {
  const part = content && content[type];
  if (!part) return "";
  switch (type) {
    case "conversation": return String(content.conversation || "");
    case "extendedTextMessage": return String(part.text || "");
    case "imageMessage":
    case "videoMessage":
    case "documentMessage": return String(part.caption || "");
    case "buttonsResponseMessage": return String(part.selectedButtonId || part.selectedDisplayText || "");
    case "listResponseMessage": return String(part.title || (part.singleSelectReply && part.singleSelectReply.selectedRowId) || "");
    case "templateButtonReplyMessage": return String(part.selectedDisplayText || part.selectedId || "");
    default: return "";
  }
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

    const content = normalizeMessageContent(msg.message);
    if (!content) return;
    const type = getContentType(content);
    if (!type || type === "protocolMessage" || type === "reactionMessage" ||
        type === "senderKeyDistributionMessage" || type === "messageContextInfo") return;
    const text = messageText(content, type);
    if (!text) return;

    const isGroup = isJidGroup(from) || from.endsWith("@g.us");
    const senderId = isGroup
      ? (key.participant || key.participantPn || key.senderPn || from)
      : (key.remoteJidAlt || from);
    const phone = await resolvePhone(senderId, msg);
    if (!phone) {
      lastInboundError = "could not resolve sender to a phone number";
      console.log("warn: could not resolve sender", senderId);
      return;
    }
    lastInboundPhone = phone;

    const context = contentContext(content, type);
    const replyTo = context.stanzaId ? String(context.stanzaId) : null;

    // Owner approval/denial works in a DM or in the group, before any gate.
    if (await handleApprovalCommand(text, phone, from, isGroup)) return;

    if (!isGroup) {
      // .allowdm: owners + admins + known group members. .disallowdm: owners + admins.
      if (!OWNERS.includes(phone) && (text === ".allowdm" || text === ".disallowdm")) return;
      if (OWNERS.includes(phone) && (text === ".allowdm" || text === ".disallowdm")) {
        setDmOpen(text === ".allowdm");
        const reply = dmOpen
          ? "okay babe, DMs are open to owners, admins and people I already know from groups"
          : "okay babe, DMs are closed again — only you, Precious and Temi can reach me now";
        console.log(`\n📩 [toggle] ${phone}\n💬 Liam: ${reply}\n`);
        await sendLong(from, reply);
        return;
      }
      const allowed = dmAllowed(phone);
      if (!allowed) {
        lastInboundKind = "dm (not allowed)";
        lastInboundError = "sender is not an owner/admin and DMs are closed";
        return;
      }
      const reply = await askLiam(text, phone, false, "", false, false);
      console.log(`\n📩 ${phone}: ${text}\n💬 Liam: ${reply}\n`);
      await sendLong(from, reply);
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
        const p = await createPermissionRequest(from, phone, text, msg);
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

    const reply = await askLiam(text, phone, true, from, mentioned, replyingToLiam);
    console.log(`\n📩 [${from}] ${who} ${phone}: ${text}\n💬 Liam: ${reply}\n`);
    // In a group, answer the exact message that triggered her with a WhatsApp
    // quoted reply instead of dropping a bare line into the chat.
    const sent = await sendLong(from, reply, { quoted: msg });
    rememberLiamMessage(from, messageId(sent));
  } catch (e) {
    lastInboundError = String(e && e.message ? e.message : e).slice(0, 400);
    console.log(`\n💀 MSG HANDLER ERROR: ${String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// InstaBox pentest VM (members need one-time owner approval)
// ---------------------------------------------------------------------------
const INSTABOX_API_KEY = String(process.env.INSTABOX_API_KEY || "").trim();
const INSTABOX_MACHINE_ID = String(process.env.INSTABOX_MACHINE_ID || "").trim();
const INSTABOX_API_URL = String(process.env.INSTABOX_API_URL || "https://api.instabox.sh").replace(/\/+$/, "").replace(/\/v1$/, "");

async function instaboxExec(command, timeoutSeconds = 120, cwd = "") {
  if (!INSTABOX_API_KEY || !INSTABOX_MACHINE_ID) {
    throw new BadRequest("InstaBox is not configured (set INSTABOX_API_KEY and INSTABOX_MACHINE_ID)");
  }
  const text = String(command || "").trim();
  if (!text) throw new BadRequest("command is empty");
  if (text.length > 8000) throw new BadRequest("command is too long");
  const timeout = Math.min(600, Math.max(1, Number.parseInt(timeoutSeconds, 10) || 120));
  const body = { cmd: text, timeoutSeconds: timeout };
  if (cwd) body.cwd = String(cwd).slice(0, 500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (timeout + 20) * 1000);
  try {
    const res = await fetch(`${INSTABOX_API_URL}/v1/machines/${encodeURIComponent(INSTABOX_MACHINE_ID)}/exec`, {
      method: "POST",
      headers: {
        "X-API-Key": INSTABOX_API_KEY,
        "Authorization": "Bearer " + INSTABOX_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch (e) { data = { raw }; }
    if (!res.ok) {
      const detail = String(data.message || data.error || raw || "").slice(0, 400);
      throw new BadRequest(`InstaBox HTTP ${res.status}${detail ? ": " + detail : ""}`);
    }
    const out = [data.stdout, data.stderr].filter((v) => v != null && String(v).length).join("\n");
    const exit = data.exitCode != null ? data.exitCode : (data.exit_code != null ? data.exit_code : "?");
    const textOut = `exit=${exit}\n${out || "(no output)"}`;
    return textOut.length > 8000 ? textOut.slice(0, 8000) + "\n… [truncated]" : textOut;
  } catch (e) {
    if (e && e.name === "AbortError") throw new BadRequest("InstaBox command timed out");
    if (e instanceof BadRequest) throw e;
    throw new BadRequest(`InstaBox request failed: ${typeName(e)}`);
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

function normalizeRecipient(value) {
  const raw = String(value || "").trim();
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
  if (!DM_ALLOW.has(bareId(jid))) throw new BadRequest("recipient is not on the allowlist");
}

function assertRate() {
  const now = Date.now();
  while (outboundLog.length && now - outboundLog[0] > OUTBOUND_WINDOW) outboundLog.shift();
  if (outboundLog.length >= OUTBOUND_MAX) throw new BadRequest("too many outbound messages - slow down");
  outboundLog.push(now);
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
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const text = String(d.text == null ? "" : d.text);
    if (!text.trim()) throw new BadRequest("message is empty");
    if (text.length > 4096) throw new BadRequest("message is too long");
    const sent = await wa.sendMessage(to, text);
    return messageId(sent) || "sent";
  }

  if (action === "image") {
    assertOwner(d);
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const caption = String(d.text || "").slice(0, 1024);
    const sent = await wa.sendMessage(to, { image: fs.readFileSync(file), caption });
    return messageId(sent) || "sent";
  }

  if (action === "voice") {
    assertOwner(d);
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const mimetype = audioMime(d.mimetype, file);
    const sent = await wa.sendMessage(to, {
      audio: fs.readFileSync(file),
      mimetype,
      ptt: true,
    });
    return messageId(sent) || "sent";
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
    TEMP[jid] = TEMP[jid] || {};
    if (d.allow) TEMP[jid][who] = Date.now();
    else TEMP[jid][who] = -Date.now();
    return d.allow ? "okay, I'll reply " + who : "okay, I'll ignore " + who;
  }

  if (action === "stop") {
    assertOwner(d);
    writeFileAtomic(STOP_FILE, "1");
    if (ctx.hard || d.hard === true) setTimeout(() => stopAgent(), 100);
    return "stopping…";
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

  throw new BadRequest("unknown action");
}

// ---------------------------------------------------------------------------
// HTTP server: health, readiness, pairing pages, local tool API
// ---------------------------------------------------------------------------
function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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

function authorized(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return false;
  return safeEqual(header.slice(7), TOOL_TOKEN);
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

function statusPayload() {
  return {
    ok: true,
    status: waState,
    detail: waStateDetail,
    whatsappReady: waState === "ready",
    agentRunning: !!(agentProc && agentProc.exitCode === null && !agentProc.killed),
    needsQr: waState === "needs_qr",
    hasSessionData: hasSessionData(),
    linkedMarker: hasLinkMarker(),
    startedAt: STARTED_AT,
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    memoryMiB: containerMemoryMiB(),
    memory: containerMemoryInfo(),
    lastQrAt: waLastQrAt || null,
    lastError: waInitError ? waInitError.split("\n")[0].slice(0, 300) : "",
    pairingEnabled: true,
    pendingGroupPermissions: pendingPerms.size,
    pendingToolApprovals: pendingTools.size,
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

function pairPage(token, opts = {}) {
  const action = `/pair?token=${encodeURIComponent(token)}`;
  const value = opts.phone ? escapeHtml(opts.phone) : BOT_PHONE;
  let result = "";
  if (opts.error) {
    result = `<div style="border:1px solid #7f1d1d;background:#2a1215;padding:.8rem 1rem;border-radius:.5rem;margin-bottom:1rem">` +
      `<p style="margin:0;color:#fecaca"><strong>Could not get a code.</strong> ${escapeHtml(opts.error)}</p></div>`;
  }
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
    `<button type="submit">Get pairing code</button></form>` +
    `<p style="opacity:.7">This page only asks WhatsApp for a code when you press the button.</p>`);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let body = "";
    let done = false;
    req.on("data", (chunk) => {
      if (done) return;
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > limit) {
        done = true;
        reject(new BadRequest("request too large"));
      }
    });
    req.on("end", () => { if (!done) resolve(body); });
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
  const limit = Number.parseInt(process.env.LIAM_MEM_LIMIT_MB || "0", 10);
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

function friendlyWaError(message) {
  const text = String(message || "");
  if (/429|rate[- ]?overlimit|too many|overlimit/i.test(text)) {
    return "WhatsApp is limiting code requests for this number. Wait 10-15 minutes, " +
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
      if (sock && sockReadyForPairing) break;
      if (!sock && !connecting && !reconnectTimer) {
        await initializeWhatsApp("pairing code request").catch(() => {});
      }
      await sleep(500);
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
  const publicGet = req.method === "GET" && ["/health", "/ready", "/status", "/qr", "/pair", "/diag", "/cancelpair", "/reset"].includes(pathname);

  if (publicGet) {
    if (pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true, status: "alive" }));
      return;
    }
    if (pathname === "/ready") {
      const ready = waState === "ready" && !!(agentProc && agentProc.exitCode === null && !agentProc.killed);
      sendJson(res, ready ? 200 : 503, { ...statusPayload(), ok: ready });
      return;
    }
    if (pathname === "/status") {
      sendJson(res, 200, statusPayload());
      return;
    }
    if (pathname === "/cancelpair") {
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendJson(res, 403, { ok: false, msg: "forbidden" });
      try {
        await Promise.race([
          cancelPairing(),
          sleep(20000).then(() => { throw new Error("cancel timed out"); }),
        ]);
        sendJson(res, 200, { ok: true, ...statusPayload() });
      } catch (e) {
        sendJson(res, 500, { ok: false, msg: String(e && e.message ? e.message : e) });
      }
      return;
    }
    if (pathname === "/reset") {
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendJson(res, 403, { ok: false, msg: "forbidden" });
      if (waState === "ready") return sendJson(res, 409, { ok: false, msg: "already linked; a reset is not needed" });
      try {
        await Promise.race([
          resetWhatsApp("manual reset"),
          sleep(180000).then(() => { throw new Error("reset timed out"); }),
        ]);
        sendJson(res, 200, { ok: true, ...statusPayload() });
      } catch (e) {
        sendJson(res, 500, { ok: false, msg: String(e && e.message ? e.message : e) });
      }
      return;
    }
    if (pathname === "/diag") {
      // Unlinked-startup diagnostics, plus safe message counters once linked.
      // Message text is never stored or exposed; the token is required.
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
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
          lastInboundError,
          lastOutboundAt: lastOutboundAt || null,
          lastAgentRequestAt: lastAgentRequestAt || null,
          lastAgentReplyAt: lastAgentReplyAt || null,
          lastAgentError,
          agentStderrTail: agentStderrTail.slice(-1200),
          // Read-only: which optional integrations have credentials present.
          // Never exposes the values, only whether each tool can work.
          config: {
            imageVoice: !!process.env.GOOGLE_API_KEY,
            search: {
              tavily: !!process.env.TAVILY_API_KEY,
              brave: !!process.env.BRAVE_API_KEY,
              serper: !!process.env.SERPER_API_KEY,
              duckduckgo: true,
            },
            instabox: {
              apiKey: !!INSTABOX_API_KEY,
              machineId: !!INSTABOX_MACHINE_ID,
              url: INSTABOX_API_URL,
            },
            email: !!(process.env.LIAM_EMAIL_HOST && process.env.LIAM_EMAIL_USER
              && process.env.LIAM_EMAIL_PASSWORD),
            dmAllowlist: DM_ALLOW.size,
            owners: OWNERS.length,
          },
          memoryMiB: containerMemoryMiB(),
          uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        };
        if (url.searchParams.get("probe") === "1") {
          try {
            const reply = await withTimeout(
              askLiam("Reply with exactly OK and do not use any tools.", OWNERS[0], false, "", false, false),
              ASK_TIMEOUT_MS,
              "probe timed out",
            );
            return sendJson(res, 200, { ...base, probeReply: String(reply == null ? "" : reply).slice(0, 600) });
          } catch (e) {
            return sendJson(res, 500, {
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
        socketUserId: socketUserId(),
        reconnectScheduled: !!reconnectTimer,
        waVersion: waVersion ? waVersion.join(".") : null,
        startedAt: STARTED_AT,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        memoryMiB: containerMemoryMiB(),
        memory: containerMemoryInfo(),
        linkedMarker: hasLinkMarker(),
        marker: readLinkMarker(),
        credsPresent: profileHasCredentials(),
        sessionFiles: (() => {
          try { return fs.readdirSync(SESSION_PROFILE_DIR).length; } catch (e) { return 0; }
        })(),
        events: waEvents.slice(-15),
      });
      return;
    }
    if (pathname === "/qr") {
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
      return sendHtml(res, 200, pageShell("Liam pairing",
        `<h1>Liam uses a phone code</h1>` +
        `<p>QR linking has been removed. Open the <a href="/pair?token=${encodeURIComponent(token)}">pairing page</a> ` +
        `and press the button to get an 8-character code.</p>` +
        (waState === "ready" ? `<p>Liam is already linked.</p>` : "")));
    }
    if (pathname === "/pair") {
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
      const phone = url.searchParams.get("phone") || "";
      // Never create a code just because the page was opened or reloaded. That
      // silently burned another request against WhatsApp's rate limit and handed
      // out codes nobody typed. Only the button (POST /pair) asks for a code.
      return sendHtml(res, 200, pairPage(token, { phone }));
    }
  }

  if (req.method === "POST" && pathname === "/pair") {
    (async () => {
      try {
        const raw = await readBody(req, 8 * 1024);
        let data = {};
        const type = String(req.headers["content-type"] || "");
        if (/application\/json/i.test(type)) data = JSON.parse(raw || "{}");
        else data = Object.fromEntries(new URLSearchParams(raw || ""));
        const token = String(data.token || url.searchParams.get("token") || "");
        if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
        const phone = String(data.phone || "");
        const code = await requestPairing(phone);
        sendHtml(res, 200, pairPage(token, { phone, code, requestedAt: lastPairAt }));
      } catch (e) {
        const token = String(url.searchParams.get("token") || "");
        if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
        sendHtml(res, 400, pairPage(token, { error: e instanceof BadRequest ? e.message : "pairing failed" }));
      }
    })();
    return;
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
  if (!authorized(req)) {
    req.resume();
    return sendJson(res, 401, { ok: false, msg: "unauthorized" });
  }
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    req.resume();
    return sendJson(res, 413, { ok: false, msg: "request too large" });
  }

  let body = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    if (tooBig) return;
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY) {
      tooBig = true;
      sendJson(res, 413, { ok: false, msg: "request too large" });
    }
  });
  req.on("end", async () => {
    if (tooBig) return;
    let data;
    try { data = JSON.parse(body || "{}"); }
    catch (e) { return sendJson(res, 400, { ok: false, msg: "invalid request" }); }
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
  console.log(`🔗 Pairing page: ${base}/pair?token=${PAIR_TOKEN}`);
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
    if (marker && marker.wid) console.log(`info: restoring linked WhatsApp session (${marker.wid})`);
  }
  await initializeWhatsApp("startup");
  startMemoryGuard();
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
  normalizeRecipient, normalizeGroup, assertAllowed, assertOutbox, audioMime, authorized,
  sync, pythonBin, sanitizeChromeLocks: sync.sanitizeChromeLocks,
  statusPayload, TEMP, tempDecision, sweepTemp, _setState: setWaState,
  stopAgent, initializeWhatsApp, hasSessionData, requestPairing, instaboxExec,
  pendingPerms, pendingTools, PAIR_TOKEN, ownerIdsInGroup, sendApprovalPrompt,
  createToolApproval, executeToolApproval, handleApprovalCommand, createPermissionRequest,
  dmAllowed, setDmOpen, rememberKnownMember, knownMembers,
  cancelPairing, resetWhatsApp, connectSocket, closeSocket, handleIncomingMessage,
  messageId, jidForSend, socketUserId, friendlyWaError,
};
