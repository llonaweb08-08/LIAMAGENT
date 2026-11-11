const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { spawn, spawnSync } = require("child_process");

// Timestamp of this process. /status exposes it so an OOM kill or crash shows up
// as a fresh start instead of silently looking like a normal reconnect.
const STARTED_AT = Date.now();

// ---------------------------------------------------------------------------
// WhatsApp Web load guard
// ---------------------------------------------------------------------------
// On Render's free tier the browser can take a long time to start WhatsApp Web.
// whatsapp-web.js injects its helpers immediately after the page loads; if the
// web app's internal Store is not ready yet, that throws
// "Cannot read properties of null (reading 'Socket')" and the QR flow restarts
// forever, so a scan is accepted by the phone but never by the server.
//
// Wait for the Store to exist before running the library's inject step, retry
// when the call still races a page reload, and report what the page actually
// shows when it never becomes ready.
const _originalInject = Client.prototype.inject;
let waInjectDiag = "";

async function describeWaPage(page) {
  if (!page) return { page: null };
  try {
    // A page stuck in a retry loop stops answering evaluate() at all, which made
    // /diag hang. Never wait longer than a few seconds for page details.
    const answered = page.evaluate(() => {
      const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
      const text = safe(() => (document.body ? document.body.innerText : "")) || "";
      return {
        href: safe(() => location.href) || "",
        title: safe(() => document.title) || "",
        readyState: safe(() => document.readyState) || "",
        hasRequire: safe(() => typeof window.require === "function") === true,
        hasSocket: safe(() => !!(window.require && window.require("WAWebSocketModel") &&
          window.require("WAWebSocketModel").Socket)) === true,
        hasAuthStore: safe(() => !!window.AuthStore) === true,
        hasPairingUtils: safe(() => !!(window.AuthStore && window.AuthStore.PairingCodeLinkUtils)) === true,
        authStoreKeys: safe(() => (window.AuthStore ? Object.keys(window.AuthStore).slice(0, 30) : [])) || [],
        text: String(text).replace(/\s+/g, " ").trim().slice(0, 200),
      };
    });
    const timeout = new Promise((resolve) => setTimeout(
      () => resolve({ page: "busy", note: "the WhatsApp page did not answer within 8 seconds" }), 8000));
    return await Promise.race([answered, timeout]);
  } catch (e) {
    return { page: "unreachable", error: String(e) };
  }
}

Client.prototype.inject = async function patchedInject(...args) {
  const storeReady = async () => {
    if (!this.pupPage) return false;
    try {
      return await this.pupPage.evaluate(() => {
        try {
          const model = window.require && window.require("WAWebSocketModel");
          return !!(model && model.Socket);
        } catch (e) {
          return false;
        }
      });
    } catch (e) {
      return false;
    }
  };
  const waitForStore = async (seconds) => {
    const deadline = Date.now() + seconds * 1000;
    while (Date.now() < deadline) {
      if (await storeReady()) return true;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return false;
  };

  // A first boot on a cold free instance can need well over a minute. Loop
  // instead of giving up after a single reload. Only one caller may reload the
  // page, otherwise every navigation would start another reload and the page
  // would never finish loading.
  const authInFlight = () =>
    waState === "linking" ||
    (authAt && Date.now() - authAt < 5 * 60 * 1000) ||
    (lastPairAt && Date.now() - lastPairAt < 5 * 60 * 1000);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    if (await waitForStore(attempt === 1 ? 45 : 20)) {
      this._liamStoreSeen = true;
      try {
        return await _originalInject.apply(this, args);
      } catch (e) {
        const msg = String(e && e.stack ? e.stack : e);
        if (!/reading 'Socket'|Cannot read properties of null|AuthStore/i.test(msg)) throw e;
        waInjectDiag = msg;
        console.log(`warn: WhatsApp inject raced the page load (attempt ${attempt}): ${msg}`);
        const info = await describeWaPage(this.pupPage);
        console.log("warn: page state:", JSON.stringify(info));
        if (/unsupported|update whatsapp|update your browser/i.test(String(info.text || ""))) {
          waInjectDiag = "WhatsApp Web says this browser is unsupported: " + String(info.text || "");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }
    }

    // Never reload a page that has already loaded or while a QR/pairing-code
    // login is being completed: a reload cancels the handshake, so the phone
    // shows the device as linked while the server falls back to a new QR.
    if (this._liamStoreSeen || authInFlight()) {
      console.log(`warn: WhatsApp Web is reloading itself (attempt ${attempt}); waiting instead of forcing a reload`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (this._liamReloading) {
      try { await this._liamReloading; } catch (e) {}
      continue;
    }
    console.log(`warn: WhatsApp Web not ready yet (attempt ${attempt}); reloading the page`);
    this._liamReloading = (async () => {
      try {
        await this.pupPage.reload({ waitUntil: "load", timeout: 90000 });
      } catch (e) {}
    })();
    try {
      await this._liamReloading;
    } finally {
      this._liamReloading = null;
    }
  }
  throw new Error("WhatsApp Web never finished loading. " + (waInjectDiag || "page stayed empty"));
};
const QRCode = require("qrcode");
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

// Remove QR images left behind by earlier runs.
for (const name of ["liam_qr.png", "whatsapp_qr.png", "scan_liam.png"]) {
  try { fs.rmSync(path.join(BASE_DIR, name), { force: true }); } catch (e) {}
}
try { fs.rmSync(QR_FILE, { force: true }); } catch (e) {}

// Drop web-version cache entries that do not match the pinned WhatsApp version.
function pinnedWebVersion() {
  try {
    const source = fs.readFileSync(path.join(
      BASE_DIR, "node_modules", "whatsapp-web.js", "src", "util", "Constants.js"), "utf8");
    const match = /webVersion:\s*'([^']+)'/.exec(source);
    return match ? match[1] : null;
  } catch (e) { return null; }
}
const CACHE_DIR = path.join(BASE_DIR, ".wwebjs_cache");
const PINNED_VERSION = pinnedWebVersion();
if (fs.existsSync(CACHE_DIR)) {
  for (const name of fs.readdirSync(CACHE_DIR)) {
    if (!PINNED_VERSION || !name.startsWith(PINNED_VERSION + ".")) {
      try { fs.rmSync(path.join(CACHE_DIR, name), { recursive: true, force: true }); } catch (e) {}
    }
  }
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
// WhatsApp client
// ---------------------------------------------------------------------------
function puppeteerArgs() {
  const base = [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--no-first-run", "--no-zygote",
  ];
  if (process.env.LIAM_CHROME_SINGLE_PROCESS === "1") base.push("--single-process");
  return base;
}

let waState = "starting";        // starting | restoring | needs_qr | linking | ready | disconnected | error
let waStateDetail = "";
let waInitError = "";
let waLastQrAt = 0;
let waInitPromise = null;
let lastQr = null;
let lastPairCode = null;
let lastPairAt = 0;
let pairingError = "";
let lastQrLogAt = 0;
let authAt = 0;
let pairingInFlight = null;

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

// True while the phone is completing a QR scan or a phone-code login. Nothing
// may reload or restart the browser in this window: doing so cancels the
// handshake and leaves a "zombie" device on the phone while the server falls
// back to a new QR.
function linkHandshakeActive() {
  return waState === "linking" &&
    Date.now() - Math.max(lastPairAt || 0, authAt || 0) < 5 * 60 * 1000;
}

// Real container memory (includes Chromium). Render kills the instance when the
// free plan's limit is exceeded, so this is the number that matters.
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

function profileHasCredentials() {
  const markers = [
    path.join(SESSION_PROFILE_DIR, "Default", "Preferences"),
    path.join(SESSION_PROFILE_DIR, "Default", "Local Storage", "leveldb"),
    path.join(SESSION_PROFILE_DIR, "Default", "IndexedDB"),
    path.join(SESSION_PROFILE_DIR, "Local State"),
  ];
  if (markers.some((p) => { try { return fs.existsSync(p); } catch (e) { return false; } })) return true;
  // Older profiles may not have the exact markers; an empty LocalAuth profile
  // (just the session directory) must not count as a linked session.
  try {
    if (!fs.existsSync(SESSION_PROFILE_DIR)) return false;
    return fs.readdirSync(SESSION_PROFILE_DIR).some((name) => name !== "Default" && name !== "SingletonLock");
  } catch (e) { return false; }
}
function hasSessionData() { return profileHasCredentials(); }

// A marker written only after WhatsApp confirms the login. It lives next to the
// Chromium profile (inside SESSION_DIR, so it travels with the Supabase
// archive). Boot uses it to tell a real linked session from a dead profile:
// Chromium always writes files like "Local State" into an empty profile, so the
// file listing alone cannot prove that WhatsApp is linked.
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

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: puppeteerArgs(),
    protocolTimeout: Number.parseInt(process.env.LIAM_PUPPETEER_TIMEOUT_MS || "180000", 10),
  },
});

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

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
    stdio: ["pipe", "pipe", "inherit"]
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
      if (msg.error) { console.log("\n💀 AGENT ERROR:", msg.error); failPending(new Error(msg.error)); continue; }
      if (Object.prototype.hasOwnProperty.call(msg, "reply")) {
        if (!agentPending) { console.log("[agent] stale reply ignored"); continue; }
        const p = agentPending; agentPending = null;
        try { clearTimeout(p.timeout); } catch (e) {}
        p.resolve(msg.reply == null ? "" : String(msg.reply));
      }
    }
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
async function resolvePhone(id) {
  const raw = String(id || "");
  const base = bareId(raw);
  if (!raw.includes("@lid")) return base;
  if (lidCache.has(base)) return lidCache.get(base);
  let phone = null;
  try {
    const res = await client.getContactLidAndPhone([raw]);
    const pn = res && res[0] && res[0].pn;
    if (pn) phone = bareId(pn);
  } catch (e) { console.log("🔍 LID lookup failed:", String(e)); }
  if (!phone) {
    try {
      const c = await client.getContactById(raw);
      if (c && c.number) phone = bareId(c.number);
    } catch (e) { console.log("🔍 contact lookup failed:", String(e)); }
  }
  if (phone) { lidCache.set(base, phone); saveLidMap(); }
  return phone || null;
}

function askLiam(user, phone, isGroup, groupJid, mentioned, replyTo) {
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
    const chat = await client.getChatById(jid);
    const parts = Array.isArray(chat && chat.participants) ? chat.participants : [];
    return OWNERS.filter((owner) => parts.some((p) => participantId(p) === owner));
  } catch (e) {
    return [];
  }
}

async function sendApprovalPrompt(text, groupJid) {
  if (groupJid) {
    const owners = await ownerIdsInGroup(groupJid);
    if (owners.length) {
      const tags = owners.map((o) => "@" + o).join(" ");
      try {
        await client.sendMessage(groupJid, `${tags} ${text}`.trim(), {
          mentions: owners.map((o) => o + "@c.us"),
        });
        return true;
      } catch (e) { console.log("warn: group approval prompt failed:", String(e)); }
    }
  }
  let sent = 0;
  for (const owner of OWNERS) {
    try {
      await client.sendMessage(owner + "@c.us", text);
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

async function createPermissionRequest(jid, phone, text) {
  sweepTemp();
  const bare = bareId(phone);
  for (const p of pendingPerms.values()) {
    if (p.jid === jid && p.phone === bare) {
      p.text = String(text || "").slice(0, 2000);
      p.ts = Date.now();
      return p;
    }
  }
  const id = makeId("p");
  const p = { id, jid, phone: bare, text: String(text || "").slice(0, 2000), ts: Date.now() };
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
      try { await client.sendMessage(ownerChat, `Done — ${p.action} ran.`); } catch (e) {}
    }
    return "approved and executed";
  } catch (e) {
    const message = e instanceof BadRequest ? e.message : "the approved action failed";
    try { await client.sendMessage(chatTarget(p.chat || p.actor, p.isGroup), `❌ ${p.action} failed: ${message}`); } catch (e2) {}
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
      try { await client.sendMessage(chat, `🚫 denied ${toolId} (${p ? p.action : "tool"}).`); } catch (e) {}
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
      try { await client.sendMessage(chat, "There is more than one request — reply with the id, e.g. `yes p123abc`."); } catch (e) {}
      return true;
    }
  }
  if (permId) {
    const p = pendingPerms.get(permId);
    pendingPerms.delete(permId);
    if (!allow) {
      TEMP[p.jid] = TEMP[p.jid] || {};
      TEMP[p.jid][p.phone] = -Date.now();
      try { await client.sendMessage(p.jid, `okay, I won't reply to ${p.phone} in this group.`); } catch (e) {}
      if (chat !== p.jid) { try { await client.sendMessage(chat, `okay — denied ${p.id}.`); } catch (e) {} }
      return true;
    }
    TEMP[p.jid] = TEMP[p.jid] || {};
    TEMP[p.jid][p.phone] = Date.now();
    try { await client.sendMessage(p.jid, `okay, I'll reply to ${p.phone} for the next 3 hours.`); } catch (e) {}
    try {
      const reply = await askLiam(p.text, p.phone, true, p.jid, true, false);
      const sent = await client.sendMessage(p.jid, reply);
      rememberLiamMessage(p.jid, sent && sent.id ? sent.id._serialized : null);
    } catch (e) { console.log("warn: approved reply failed:", String(e)); }
    if (chat !== p.jid) { try { await client.sendMessage(chat, `okay — allowed ${p.phone} for 3 hours.`); } catch (e) {} }
    return true;
  }

  if (wanted) {
    const prefix = wanted[0];
    if (prefix === "t" || prefix === "p") {
      try { await client.sendMessage(chat, `I don't see ${wanted} — it expired or was already used.`); } catch (e) {}
      return true;
    }
  }
  if (!wanted && pendingTools.size) {
    try {
      await client.sendMessage(chat, "Tool approvals need the request id — reply `yes t…` or `no t…`.");
    } catch (e) {}
    return true;
  }
  return false;
}

function removeQr() {
  lastQr = null;
  try { fs.rmSync(QR_FILE, { force: true }); } catch (e) {}
}

client.on("qr", async (qr) => {
  // After a scan WhatsApp reloads the web app and can emit one last QR from the
  // old page. Ignoring it keeps the phone-side "linked" state from flipping
  // back to "scan me" while authentication finishes. The same applies to a
  // phone-code login: WhatsApp Web keeps emitting QRs behind the code screen,
  // and showing them would hide that a link is in progress.
  const pairingWindow = linkHandshakeActive();
  if (waState === "ready" || pairingWindow) {
    return;
  }
  setWaState("needs_qr", "scan the QR code or use the pairing page to link WhatsApp");
  waLastQrAt = Date.now();
  lastQr = String(qr || "");
  noteWaEvent("qr");
  try {
    await QRCode.toFile(QR_FILE, qr, { width: 520, margin: 2 });
    try { fs.chmodSync(QR_FILE, 0o600); } catch (e) {}
    // WhatsApp rotates the QR every ~20 seconds. Writing the file every time is
    // required, but logging every rotation only floods Render's log viewer.
    if (!lastQrLogAt || Date.now() - lastQrLogAt >= 5 * 60 * 1000) {
      lastQrLogAt = Date.now();
      console.log("\n📱 QR READY — open the pairing page from the logs to scan it.");
    }
  } catch (e) { console.log("\n❌ QR FAILED:", String(e)); }
});
client.on("code", (code) => { lastPairCode = String(code || ""); lastPairAt = Date.now(); setWaState("linking", "pairing code generated"); noteWaEvent("code"); });
let readyHandled = false;
function handleReady() {
  if (readyHandled) return;
  readyHandled = true;
  noteWaEvent("ready");
  console.log("\n🚀 LIAM IS LIVE — waiting for messages...\n");
  removeQr();
  setWaState("ready", "WhatsApp connected");
  // Remember that this profile is a real, completed login. Boot wipes any
  // profile without this marker so a half-finished link cannot poison the next
  // attempt.
  try {
    const wid = client.info && client.info.wid
      ? String(client.info.wid._serialized || client.info.wid)
      : "linked";
    markLinked({ wid });
  } catch (e) {
    markLinked({ wid: "linked" });
  }
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

client.on("authenticated", () => {
  authAt = Date.now();
  noteWaEvent("authenticated");
  removeQr();
  setWaState("linking", "authenticated, finishing startup");
  console.log("\n✅ LIAM LINKED — finishing startup\n");
  // Some WhatsApp Web builds authenticate but never emit "ready". Poll the
  // connection for a few minutes and start the agent as soon as it is
  // CONNECTED, instead of dropping the new login and showing another QR.
  let checks = 0;
  const poll = setInterval(async () => {
    checks += 1;
    if (readyHandled || waState === "ready") { clearInterval(poll); return; }
    if (checks > 18) { clearInterval(poll); return; }
    try {
      const state = await Promise.race([
        client.getState(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("state timeout")), 10000)),
      ]);
      if (String(state) === "CONNECTED") {
        console.log("note: ready event was delayed; WhatsApp state is CONNECTED");
        clearInterval(poll);
        handleReady();
      }
    } catch (e) {}
  }, 10000);
});
client.on("auth_failure", (m) => {
  removeQr();
  clearLinkMarker();
  setWaState("error", "WhatsApp auth failed");
  noteWaEvent("auth_failure", m);
  console.log("\n❌ AUTH FAILED:", String(m));
  stopAgent();
  autoReset("WhatsApp rejected the login");
});
client.on("loading_screen", (percent) => { if (Number(percent) >= 100) console.log("info: WhatsApp Web loaded 100%"); });
client.on("ready", handleReady);
let disconnectCount = 0;
let disconnectWindowStart = 0;
client.on("disconnected", (r) => {
  removeQr();
  const reason = String(r && r.toString ? r.toString() : r);
  noteWaEvent("disconnected", reason);
  console.log("\n⚠️ Disconnected:", reason);
  stopAgent();
  if (/LOGOUT/i.test(reason)) {
    // The phone removed this device. The stored profile is dead; restart with
    // a clean QR instead of restoring it.
    clearLinkMarker();
    setWaState("error", "WhatsApp logged out");
    autoReset("the phone removed this device");
    return;
  }
  const now = Date.now();
  if (!disconnectWindowStart || now - disconnectWindowStart > 5 * 60 * 1000) {
    disconnectWindowStart = now;
    disconnectCount = 0;
  }
  disconnectCount += 1;
  if (disconnectCount > 2) {
    setWaState("error", "WhatsApp keeps disconnecting");
    autoReset("WhatsApp keeps disconnecting");
    return;
  }
  // Keep the freshly-linked profile alive: close the broken browser and start
  // again from the same session instead of exiting and losing the pairing.
  setWaState("disconnected", "connection dropped; reconnecting");
  setTimeout(async () => {
    try {
      if (waState === "ready") return;
      // Never tear the browser down in the middle of a scan or phone-code
      // handshake: WhatsApp Web reconnects on its own, and a restart here is
      // exactly what leaves a zombie device on the phone.
      if (linkHandshakeActive()) {
        noteWaEvent("reconnect_deferred", "link in progress");
        console.log("info: not restarting the browser while a link is being completed");
        return;
      }
      readyHandled = false;
      try { if (client.pupBrowser) await client.destroy(); } catch (e) {}
      await sleep(3000);
      await initializeWhatsApp("reconnect after disconnect");
    } catch (e) { console.log("warn: reconnect failed:", String(e)); }
  }, 5000);
});
client.on("change_state", (s) => { if (waState !== "ready" && waState !== "needs_qr") setWaState(waState, String(s || waStateDetail)); });

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
  if (isGroup || raw.endsWith("@g.us") || raw.endsWith("@c.us")) return raw;
  return raw + "@c.us";
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

async function sendLong(to, text) {
  let last = null;
  for (const chunk of splitMessage(text)) {
    if (!chunk.trim()) continue;
    last = await client.sendMessage(to, chunk);
  }
  return last;
}

async function ownerPresentInGroup(jid) {
  return (await ownerIdsInGroup(jid)).length > 0;
}

client.on("message", async (msg) => {
  try {
  const text = msg.body;
  if (!text || msg.fromMe) return;
  const from = msg.from;
  if (from === "status@broadcast" || from.endsWith("@broadcast") || from.endsWith("@newsletter")) return;

  const isGroup = from.endsWith("@g.us");
  const senderId = isGroup ? (msg.author || from) : from;
  const phone = await resolvePhone(senderId);
  if (!phone) { console.log("warn: could not resolve sender", senderId); return; }

  let replyTo = null;
  if (msg.hasQuotedMsg) {
    try { const q = await msg.getQuotedMessage(); replyTo = q && q.id ? q.id._serialized : null; } catch (e) {}
  }

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
    if (!allowed) return;
    const reply = await askLiam(text, phone, false, "", false, false);
    console.log(`\n📩 ${phone}: ${text}\n💬 Liam: ${reply}\n`);
    await sendLong(from, reply);
    return;
  }

  // Track people Liam has seen in a group; used only by .allowdm.
  if (!OWNERS.includes(phone) && !(phone in ADMINS)) rememberKnownMember(phone);

  const selfId = client.info && client.info.wid ? client.info.wid._serialized : "";
  const selfBare = bareId(selfId);
  const mentioned =
    (Array.isArray(msg.mentionedIds) && msg.mentionedIds.some((id) => bareId(id) === selfBare)) ||
    (!!selfBare && text.includes("@" + selfBare)) ||
    isNameMention(text);
  const replyingToLiam = !!replyTo && isLiamMessage(from, replyTo);
  if (!mentioned && !replyingToLiam) return;

  let who;
  if (OWNERS.includes(phone)) who = "owner";
  else if (phone in ADMINS) who = "admin";
  else who = "member";

  // Members need a 3-hour permission per group. Owners and admins do not.
  if (who === "member") {
    const decision = tempDecision(from, phone);
    if (decision === "deny") return;
    if (decision !== "allow") {
      const p = await createPermissionRequest(from, phone, text);
      if (!p) {
        try { await client.sendMessage(from, "I couldn't reach an owner to approve that, so I didn't reply."); } catch (e) {}
        return;
      }
      try {
        await client.sendMessage(from, `I've asked the owner whether I can reply to ${phone}. (request ${p.id})`);
      } catch (e) {}
      return;
    }
  }

  const reply = await askLiam(text, phone, true, from, mentioned, replyingToLiam);
  console.log(`\n📩 [${from}] ${who} ${phone}: ${text}\n💬 Liam: ${reply}\n`);
  const sent = await sendLong(from, reply);
  rememberLiamMessage(from, sent && sent.id ? sent.id._serialized : null);
  } catch (e) { console.log(`\n💀 MSG HANDLER ERROR: ${String(e)}`); }
});

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
  const match = /^(\d{6,20})@c\.us$/.exec(raw);
  if (match) return match[1] + "@c.us";
  if (/^\d{6,20}$/.test(raw)) return raw + "@c.us";
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
    const sent = await client.sendMessage(to, text);
    return sent && sent.id ? sent.id._serialized : "sent";
  }

  if (action === "image") {
    assertOwner(d);
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const caption = String(d.text || "").slice(0, 1024);
    const sent = await client.sendMessage(to, MessageMedia.fromFilePath(file), { caption });
    return sent && sent.id ? sent.id._serialized : "sent";
  }

  if (action === "voice") {
    assertOwner(d);
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const mimetype = audioMime(d.mimetype, file);
    const sent = await client.sendMessage(to, MessageMedia.fromFilePath(file), {
      sendAudioAsVoice: true,
      mimetype,
    });
    return sent && sent.id ? sent.id._serialized : "sent";
  }

  if (action === "leave") {
    assertOwner(d);
    const jid = normalizeGroup(d.jid);
    const chat = await client.getChatById(jid);
    if (!chat || typeof chat.leave !== "function") throw new BadRequest("I can't leave that group");
    await chat.leave();
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
  if (opts.error) result = `<p style="color:#fca5a5">${escapeHtml(opts.error)}</p>`;
  if (opts.code) {
    const formatted = opts.code.length === 8 ? `${opts.code.slice(0, 4)}-${opts.code.slice(4)}` : opts.code;
    const asked = opts.requestedAt ? new Date(opts.requestedAt).toLocaleTimeString() : "";
    result = `<p>Enter this 8-character code in WhatsApp → Linked devices → Link with phone number:</p>` +
      `<p><code id="code" style="font-size:1.7rem;letter-spacing:.15em">${escapeHtml(formatted)}</code></p>` +
      `<p style="opacity:.8">Requested at ${escapeHtml(asked)}. <strong>Do not close or reload this page.</strong> ` +
      `If the code is older than about a minute, get a new one below.</p>` +
      `<p id="age" style="color:#fca5a5;font-weight:600"></p>` +
      `<script>(function(){var t0=Date.now();setInterval(function(){` +
      `var s=Math.round((Date.now()-t0)/1000);var e=document.getElementById('age');if(!e)return;` +
      `e.textContent = s>75 ? 'This code has almost certainly expired — get a new one below.' : '';` +
      `},1000);})();</script>`;
  }
  return pageShell("Liam pairing", `<h1>Pair Liam</h1>${result}` +
    `<p style="opacity:.8">First open the phone: <strong>WhatsApp → Linked devices → Link with phone number</strong>, ` +
    `so it is waiting for a code. Then press the button here and type the code straight away.</p>` +
    `<form method="post" action="${action}">` +
    `<label for="phone">WhatsApp number with country code (digits only)</label>` +
    `<input id="phone" name="phone" inputmode="numeric" autocomplete="tel" value="${value}" required>` +
    `<button type="submit">${opts.code ? "Get a new code" : "Get pairing code"}</button></form>` +
    `<p style="opacity:.7">Or use the QR page: <a href="/qr?token=${encodeURIComponent(token)}">/qr</a></p>`);
}

function qrPage(token, opts = {}) {
  if (opts.error) return pageShell("Liam QR", `<h1>QR unavailable</h1><p>${escapeHtml(opts.error)}</p>`);
  if (opts.dataUrl) {
    return pageShell("Liam QR", `<h1>Scan to link Liam</h1><img alt="WhatsApp QR code" src="${opts.dataUrl}">` +
      `<p>WhatsApp → Linked devices → Link a device. This page refreshes every 20 seconds.</p>` +
      `<meta http-equiv="refresh" content="20;url=/qr?token=${encodeURIComponent(token)}">`);
  }
  return pageShell("Liam QR", `<h1>Waiting for a QR code…</h1><p>WhatsApp is still starting. This page refreshes automatically.</p>` +
    `<p>Status: <code>${escapeHtml(waState)}</code></p>` +
    `<meta http-equiv="refresh" content="3;url=/qr?token=${encodeURIComponent(token)}">`);
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

// Stop WhatsApp Web's pairing-code mode and go back to QR mode.
// requestPairingCode() installs a repeating timer inside the page that retries
// the alt-device-link request every few minutes. When WhatsApp rate-limits the
// account, that timer keeps hitting the limit in the background and the QR
// stops rotating, so a failed code attempt must always be cancelled.
async function cancelPairing() {
  let cleared = false;
  try {
    if (client.pupPage) {
      cleared = await client.pupPage.evaluate(() => {
        let had = false;
        try {
          if (window.codeInterval) { clearInterval(window.codeInterval); window.codeInterval = null; had = true; }
        } catch (e) {}
        return had;
      });
    }
  } catch (e) {}
  try {
    if (typeof client.cancelPairingCode === "function") await client.cancelPairingCode();
  } catch (e) { console.log("warn: cancelPairingCode failed:", String(e).split("\n")[0]); }
  if (waState !== "ready") setWaState("needs_qr", "pairing cancelled; scan the QR code");
  return cleared;
}

// Wipe the local WhatsApp profile and load a brand-new WhatsApp Web page.
// A Chromium profile left behind by an interrupted link can keep WhatsApp in a
// half-linked state; this returns the browser to a clean first-run profile
// without needing a Render restart.
let resetInFlight = null;
async function resetWhatsApp(reason, opts = {}) {
  if (resetInFlight) return resetInFlight;
  const wipe = opts.wipe !== false;
  resetInFlight = (async () => {
    noteWaEvent("reset", `${reason || "manual reset"}${wipe ? "" : " (profile kept)"}`);
    console.log(`\n♻️ Resetting WhatsApp: ${reason || "manual reset"}${wipe ? " (clean profile)" : " (profile kept)"}`);
    setWaState("starting", wipe ? "resetting WhatsApp (clean profile)" : "recycling the browser (profile kept)");
    stopAgent();
    readyHandled = false;
    lastPairCode = null;
    lastPairAt = 0;
    pairingError = "";
    pairingInFlight = null;
    waInjectDiag = "";
    waInitError = "";
    removeQr();
    if (wipe) clearLinkMarker();
    try {
      if (client && typeof client.destroy === "function") {
        await Promise.race([client.destroy(), sleep(15000)]);
      }
    } catch (e) { console.log("warn: reset could not close the browser:", String(e).split("\n")[0]); }
    try { client.pupPage = null; client.pupBrowser = null; } catch (e) {}
    if (wipe) {
      try { fs.rmSync(SESSION_PROFILE_DIR, { recursive: true, force: true }); } catch (e) {}
    }
    setWaState("needs_qr", wipe ? "clean profile; waiting for a QR code" : "browser recycled; waiting for a QR code");
    await initializeWhatsApp(wipe ? "reset" : "browser recycle");
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
// plan's memory limit is exceeded. Recycle just the browser before that happens.
// The profile is kept, so a linked account reconnects without re-pairing.
let memoryGuardTimer = null;
function startMemoryGuard() {
  if (memoryGuardTimer) return;
  // Opt-in only: the boot peak is inherent to loading WhatsApp Web, and
  // recycling during a login would cancel the link. Set LIAM_MEM_LIMIT_MB to a
  // value below the plan limit to enable an early browser recycle.
  const limit = Number.parseInt(process.env.LIAM_MEM_LIMIT_MB || "0", 10);
  if (!Number.isFinite(limit) || limit < 300) return;
  memoryGuardTimer = setInterval(() => {
    const used = containerMemoryMiB();
    if (!used || used < limit) return;
    if (resetInFlight || linkHandshakeActive()) return;
    if (waState === "starting" || waState === "restoring") return;
    if (Date.now() - lastMemoryReset < 5 * 60 * 1000) return;
    lastMemoryReset = Date.now();
    console.log(`warn: memory at ${used} MiB (limit ${limit} MiB); recycling the browser to avoid an out-of-memory kill`);
    noteWaEvent("memory_reset", `${used} MiB`);
    resetWhatsApp(`memory guard (${used} MiB)`, { wipe: false })
      .catch((e) => console.log("warn: memory recycle failed:", String(e)));
  }, 20000);
  if (typeof memoryGuardTimer.unref === "function") memoryGuardTimer.unref();
}

async function requestPairing(phone) {
  const normalized = String(phone || "").replace(/\D/g, "");
  if (!/^\d{7,15}$/.test(normalized)) {
    throw new BadRequest("phone must be the full international number, digits only (e.g. 447881161023)");
  }
  if (waState === "ready") throw new BadRequest("this WhatsApp account is already linked");
  if (pairingInFlight) return pairingInFlight;
  // WhatsApp rate-limits code requests hard and every request restarts the
  // block. Give the same code back while it is fresh, then enforce a cooldown.
  const sinceLast = lastPairAt ? Date.now() - lastPairAt : Infinity;
  if (sinceLast < 60 * 1000 && lastPairCode) return lastPairCode;
  if (sinceLast < PAIRING_COOLDOWN_MS) {
    const wait = Math.ceil((PAIRING_COOLDOWN_MS - sinceLast) / 1000);
    throw new BadRequest(
      `a code was requested ${Math.round(sinceLast / 1000)} seconds ago; wait ${wait} seconds before asking again — ` +
      "every request restarts WhatsApp's own rate limit");
  }
  pairingInFlight = (async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (client.pupPage) break;
      await sleep(500);
    }
    if (!client.pupPage) throw new BadRequest("WhatsApp is still starting — try again in a few seconds");
    try {
      const code = await Promise.race([
        // The third argument is the page-side retry interval. Using the largest
        // allowed delay stops WhatsApp Web from re-requesting a code in the
        // background after a rate limit.
        client.requestPairingCode(normalized, true, 2147483647),
        sleep(90000).then(() => { throw new Error("the phone-code screen did not appear within 90 seconds"); }),
      ]);
      lastPairCode = String(code || "");
      lastPairAt = Date.now();
      pairingError = "";
      setWaState("linking", "pairing code generated");
      return lastPairCode;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e).split("\n")[0].slice(0, 200);
      pairingError = msg;
      noteWaEvent("pairing_failed", msg);
      console.log("warn: pairing code failed:", msg);
      await cancelPairing();
      throw new BadRequest("could not generate a pairing code: " + msg);
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
        const cleared = await Promise.race([
          cancelPairing(),
          sleep(20000).then(() => { throw new Error("cancel timed out"); }),
        ]);
        sendJson(res, 200, { ok: true, clearedPageTimer: cleared, ...statusPayload() });
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
      // Unlinked-startup diagnostics only. Once WhatsApp is linked this page
      // could expose message text, so it stays closed.
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
      if (waState === "ready") return sendJson(res, 200, { ok: true, status: waState, note: "linked; diagnostics hidden" });
      const page = await describeWaPage(client.pupPage);
      sendJson(res, 200, {
        ok: true,
        status: waState,
        detail: waStateDetail,
        lastError: waInitError,
        injectError: waInjectDiag,
        pairingError,
        pairingRequestedAt: lastPairAt || null,
        authenticatedAt: authAt || null,
        codeAgeSeconds: lastPairCode && lastPairAt ? Math.round((Date.now() - lastPairAt) / 1000) : null,
        linkHandshakeActive: linkHandshakeActive(),
        startedAt: STARTED_AT,
        uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
        memoryMiB: containerMemoryMiB(),
        memory: containerMemoryInfo(),
        linkedMarker: hasLinkMarker(),
        marker: readLinkMarker(),
        profileFiles: (() => {
          try { return fs.readdirSync(SESSION_PROFILE_DIR).length; } catch (e) { return 0; }
        })(),
        events: waEvents.slice(-15),
        page,
      });
      return;
    }
    if (pathname === "/qr") {
      const token = url.searchParams.get("token") || "";
      if (!pairTokenOk(token)) return sendHtml(res, 403, pageShell("Forbidden", "<h1>Forbidden</h1>"));
      if (waState === "ready") return sendHtml(res, 200, pageShell("Liam QR", "<h1>Liam is already linked.</h1>"));
      if (!lastQr) return sendHtml(res, 200, qrPage(token));
      QRCode.toDataURL(lastQr, { width: 520, margin: 2 }).then((dataUrl) => {
        sendHtml(res, 200, qrPage(token, { dataUrl }));
      }).catch(() => sendHtml(res, 500, qrPage(token, { error: "QR rendering failed" })));
      return;
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
  if (PUBLIC_URL) console.log(`🔗 QR page: ${base}/qr?token=${PAIR_TOKEN}`);
});

async function initializeWhatsApp(reason) {
  if (waInitPromise) return waInitPromise;
  waInitPromise = (async () => {
    try {
      setWaState(waState === "ready" ? "ready" : "starting", reason || "initializing WhatsApp");
      const timeoutMs = Math.max(60000, Number.parseInt(process.env.LIAM_INIT_TIMEOUT_MS || "300000", 10));
      await Promise.race([
        client.initialize(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("WhatsApp init timed out")), timeoutMs)),
      ]);
    } catch (e) {
      const msg = String(e && e.stack ? e.stack : e);
      waInitError = msg;
      console.log("\n💀 WHATSAPP INIT FAILED:", msg);
      if (/singleton|profile appears to be in use|ProcessSingleton|Code: 21/i.test(msg)) {
        const removed = sync.sanitizeChromeLocks(SESSION_DIR);
        console.log(`🔧 Removed ${removed} stale Chrome lock file(s); retrying WhatsApp init once...`);
        setWaState("starting", "retrying after stale Chrome lock cleanup");
        try {
          await client.initialize();
          waInitError = "";
          return;
        } catch (e2) {
          waInitError = String(e2 && e2.stack ? e2.stack : e2);
          console.log("\n💀 WHATSAPP INIT RETRY FAILED:", waInitError);
        }
      }
      // A half-started browser cannot recover on its own. Close it and give the
      // free instance one clean attempt instead of sitting in "error" forever.
      try {
        console.log("🔁 Restarting the browser for a clean WhatsApp Web load...");
        try { if (client && client.pupBrowser) await client.destroy(); } catch (e2) {}
        await sleep(3000);
        setWaState("starting", "retrying WhatsApp init with a fresh browser");
        await client.initialize();
        waInitError = "";
        return;
      } catch (e3) {
        waInitError = String(e3 && e3.stack ? e3.stack : e3);
        console.log("\n💀 WHATSAPP CLEAN RETRY FAILED:", waInitError);
      }
      setWaState("error", "WhatsApp init failed");
    } finally {
      waInitPromise = null;
    }
  })();
  return waInitPromise;
}

async function boot() {
  setWaState("restoring", "restoring state from Supabase (if configured)");
  // Restore to completion before Chromium starts. Abandoning a restore on a
  // timer would let it swap the profile underneath a running browser, so the
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
    if (removed) console.log(`🔧 Sanitized ${removed} stale Chrome lock file(s) before init`);
  } catch (e) {
    console.log("warn: restore phase failed:", String(e));
  }
  if (!hasLinkMarker()) {
    // No completed WhatsApp login on this profile. Chromium always writes files
    // like "Local State" into an empty profile, so the file listing cannot prove
    // that WhatsApp is linked. A leftover or half-restored profile makes the web
    // app start with a dead identity: the phone accepts a scan or code, then the
    // link never completes. Throw it away so every attempt starts clean.
    let removed = false;
    if (fs.existsSync(SESSION_PROFILE_DIR)) {
      try { fs.rmSync(SESSION_PROFILE_DIR, { recursive: true, force: true }); removed = true; } catch (e) {}
    }
    removeQr();
    console.log(removed
      ? "info: discarded the unlinked WhatsApp profile — starting from a clean browser profile"
      : "info: no linked WhatsApp profile yet — starting from a clean browser profile");
    setWaState("needs_qr", "no saved WhatsApp session; waiting for QR or pairing code");
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
    if (client && typeof client.destroy === "function") {
      await Promise.race([client.destroy(), sleep(5000)]);
    }
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
  server, client, sweepTimer, outboundLog, handleAction,
  normalizeRecipient, normalizeGroup, assertAllowed, assertOutbox, audioMime, authorized,
  sync, pythonBin, sanitizeChromeLocks: sync.sanitizeChromeLocks,
  statusPayload, TEMP, tempDecision, sweepTemp, _setState: setWaState,
  stopAgent, initializeWhatsApp, hasSessionData, requestPairing, instaboxExec,
  pendingPerms, pendingTools, PAIR_TOKEN, ownerIdsInGroup, sendApprovalPrompt,
  createToolApproval, executeToolApproval, handleApprovalCommand, createPermissionRequest,
  dmAllowed, setDmOpen, rememberKnownMember, knownMembers,
};
