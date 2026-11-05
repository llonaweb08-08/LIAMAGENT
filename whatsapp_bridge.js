const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { spawn, spawnSync } = require("child_process");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

process.on("unhandledRejection", (r) => { console.log("\n💀 UNHANDLED REJECTION:", String(r)); });
process.on("uncaughtException", (e) => { console.log("\n💀 UNCAUGHT EXCEPTION:", String(e)); });

// ---------------------------------------------------------------------------
// Paths and shared config
// ---------------------------------------------------------------------------
const BASE_DIR = __dirname;
const DATA_DIR = process.env.LIAM_DATA_DIR || path.join(
  process.env.LOCALAPPDATA || os.homedir(), "LiamWhatsApp");
const SESSION_DIR = path.join(DATA_DIR, "liam_session");
const OUTBOX_DIR = path.join(DATA_DIR, "outbox");
const TOKEN_FILE = path.join(DATA_DIR, "tool_token");
const STOP_FILE = path.join(DATA_DIR, "stop_flag");
const BRAIN_FILE = path.join(DATA_DIR, "brain_state");
const QR_FILE = path.join(DATA_DIR, "qr.png");

const MAX_BODY = 64 * 1024;
const MAX_MEDIA = 25 * 1024 * 1024;
const OUTBOUND_WINDOW = 60 * 1000;
const OUTBOUND_MAX = 20;
const PORT = Number.parseInt(process.env.LIAM_PORT || "5678", 10);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error("LIAM_PORT must be a TCP port between 0 and 65535");
}

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
// Local tool endpoint token (shared with the Python agent through DATA_DIR)
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
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: { headless: true, args: ["--disable-dev-shm-usage"] }
});

let dmOnlyOwner = false;          // default: DMs open. .disallowdm limits to owners + admins, .allowdm reopens
const TEMP = {};                 // group permissions, wiped after 30 min
const lastLiam = {};             // last message ID Liam sent per chat (reply-to detection)
const TEMP_MIN = 30 * 60 * 1000;
let agentProc = null;            // spawned python agent process
let agentPending = null;         // { resolve, reject } for the one in-flight request
let agentQueue = Promise.resolve();

function startAgent() {
  if (agentProc) return agentProc;
function pythonBin() {
  if (process.env.LIAM_PYTHON) return process.env.LIAM_PYTHON;
  try {
    const r = spawnSync("python", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout) return r.stdout.trim();
  } catch (e) {}
  return "python";
}
  agentProc = spawn(pythonBin(), ["-X", "utf8", "agent.py"], {
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
  const proc = agentProc;
  let buf = "";

  const failPending = (err) => {
    if (!agentPending) return;
    const p = agentPending; agentPending = null;
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
        if (!agentPending) { console.log("[agent] stray reply:", JSON.stringify(msg.reply)); continue; }
        const p = agentPending; agentPending = null;
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
  if (agentPending) { const p = agentPending; agentPending = null; p.reject(new Error("agent stopped")); }
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
    agentPending = { resolve, reject };
    const payload = JSON.stringify({
      u: String(user == null ? "" : user),
      s: String(phone == null ? "" : phone),
      g: !!isGroup,
      j: groupJid || "",
      m: !!mentioned,
      r: !!replyTo
    });
    try { proc.stdin.write(payload + "\n"); }
    catch (e) { agentPending = null; reject(e); }
  });
  const run = agentQueue.then(job, job);
  const timed = Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error("agent timed out")), 120000))]);
  agentQueue = run.catch(() => {});
  return timed;
}

// sweep temp permissions that are 30 min old
const sweepTimer = setInterval(() => { const now = Date.now();
  for (const jid in TEMP) for (const n in TEMP[jid])
    if (now - TEMP[jid][n] > TEMP_MIN) delete TEMP[jid][n];
}, 60000);

function removeQr() {
  try { fs.rmSync(QR_FILE, { force: true }); } catch (e) {}
}

client.on("qr", async (qr) => {
  try {
    await QRCode.toFile(QR_FILE, qr, { width: 520, margin: 2 });
    try { fs.chmodSync(QR_FILE, 0o600); } catch (e) {}
    console.log("\n📱 SCAN THIS QR CODE TO LINK LIAM! SAVED AT: " + QR_FILE);
  } catch (e) { console.log("\n❌ QR FAILED:", String(e)); }
});
client.on("authenticated", () => { removeQr(); console.log("\n✅ LIAM LINKED — ready!\n"); });
client.on("auth_failure", (m) => { removeQr(); console.log("\n❌ AUTH FAILED:", m); stopAgent(); setTimeout(() => process.exit(1), 5000); });
client.on("ready", async () => {
  console.log("\n🚀 LIAM IS LIVE — waiting for messages...\n");
  removeQr();
  startAgent();
});
client.on("disconnected", (r) => { removeQr(); console.log("\n⚠️ Disconnected:", r && r.toString()); stopAgent(); setTimeout(() => process.exit(1), 5000); });

client.on("message", async (msg) => {
  try {
  const text = msg.body;
  console.log(`\n📥 RAW MSG from=${msg.from} fromMe=${msg.fromMe} type=${msg.type} hasQuotedMsg=${!!msg.hasQuotedMsg} body=${JSON.stringify(text)}`);
  if (!text || msg.fromMe) return;
  const from = msg.from;
  if (from === "status@broadcast" || from.endsWith("@broadcast") || from.endsWith("@newsletter")) return;

  const isGroup = from.endsWith("@g.us");
  // In groups msg.from is the GROUP id; msg.author is the real sender.
  const senderId = isGroup ? (msg.author || from) : from;
  const phone = await resolvePhone(senderId);
  console.log(`\n🔍 RESOLVED chat=${from} sender=${senderId} phone=${phone} isGroup=${isGroup}`);

  let replyTo = null;
  if (msg.hasQuotedMsg) {
    try { const q = await msg.getQuotedMessage(); replyTo = q && q.id ? q.id._serialized : null; } catch (e) {}
  }

  // .allowdm / .disallowdm — DM from the owner, works BEFORE any whitelist check
  if (!isGroup && OWNERS.includes(phone) && (text === ".allowdm" || text === ".disallowdm")) {
    dmOnlyOwner = (text === ".disallowdm");
    const reply = dmOnlyOwner
      ? "okay babe, DMs are closed again — only you, Precious and Temi can reach me now"
      : "okay babe, DMs are wide open — anyone can talk to me now";
    console.log(`\n📩 [toggle] ${phone}\n💬 Liam: ${reply}\n`);
    await client.sendMessage(from, reply);
    return;
  }

  if (!isGroup) {
    // DMs: open by default; .disallowdm limits them to owners + admins
    if (dmOnlyOwner && !OWNERS.includes(phone) && !(phone in ADMINS)) return;
    const reply = await askLiam(text, phone, false, "", false, false);
    console.log(`\n📩 ${phone}: ${text}\n💬 Liam: ${reply}\n`);
    await client.sendMessage(from, reply);
    return;
  }

  // GROUPS: activated by a tag (@Liam / @<bot number>) or by a reply to her last message
  const selfId = client.info && client.info.wid ? client.info.wid._serialized : "";
  const selfBare = bareId(selfId);
  const mentioned =
    (Array.isArray(msg.mentionedIds) && msg.mentionedIds.some((id) => bareId(id) === selfBare)) ||
    (!!selfBare && text.includes("@" + selfBare)) ||
    /@Liam\b/i.test(text) ||
    /\bliam\b/i.test(text);
  const replyingToLiam = !!replyTo && lastLiam[from] === replyTo;
  if (!mentioned && !replyingToLiam) return;

  let who;
  if (OWNERS.includes(phone)) who = "owner";
  else if (phone in ADMINS) who = "admin";
  else who = "member";

  // Permission gate for non-owners/admins mentioning Liam
  if (who === "member" && mentioned) {
    if (!global.pendingPerm) global.pendingPerm = {};
    const ownerTag = OWNERS[0] ? "@" + OWNERS[0] : "";
    global.pendingPerm[from] = global.pendingPerm[from] || [];
    global.pendingPerm[from].push({ id: Date.now(), text, phone, ts: Date.now() });
    await client.sendMessage(from, `${ownerTag} Babe, can I reply to ${phone}?`);
    return;
  }

  // Owner approval of pending permission
  if (who === "owner" && /^(yes|allow|ok|sure)$/i.test(text.trim()) && global.pendingPerm && global.pendingPerm[from] && global.pendingPerm[from].length) {
    const list = global.pendingPerm[from];
    const p = list[list.length - 1];
    global.pendingPerm[from] = list.filter((x) => x !== p);
    const reply = await askLiam(p.text, p.phone || bareId(p.phone), true, from, true, false);
    const sent = await client.sendMessage(from, reply);
    lastLiam[from] = sent && sent.id ? sent.id._serialized : null;
    return;
  }
  const reply = await askLiam(text, phone, true, from, mentioned, replyingToLiam);
  console.log(`\n📩 [${from}] ${who} ${phone}: ${text}\n💬 Liam: ${reply}\n`);
  const sent = await client.sendMessage(from, reply);
  lastLiam[from] = sent && sent.id ? sent.id._serialized : null;
  } catch (e) { console.log(`\n💀 MSG HANDLER ERROR: ${String(e)}`); }
});

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

async function handleAction(d) {
  if (!d || typeof d.action !== "string") throw new BadRequest("invalid request");
  const action = d.action;

  if (action === "send") {
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
    const to = normalizeRecipient(d.to);
    assertAllowed(to);
    assertRate();
    const file = assertOutbox(d.path);
    const caption = String(d.text || "").slice(0, 1024);
    const sent = await client.sendMessage(to, MessageMedia.fromFilePath(file), { caption });
    return sent && sent.id ? sent.id._serialized : "sent";
  }

  if (action === "voice") {
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
    const jid = normalizeGroup(d.jid);
    const chat = await client.getChatById(jid);
    if (!chat || typeof chat.leave !== "function") throw new BadRequest("I can't leave that group");
    await chat.leave();
    return "I've left the group";
  }

  if (action === "permission") {
    const jid = normalizeGroup(d.jid);
    const who = String(d.who || "").trim();
    if (!/^\d{6,20}$/.test(who)) throw new BadRequest("invalid member");
    if (typeof d.allow !== "boolean") throw new BadRequest("allow must be true or false");
    TEMP[jid] = TEMP[jid] || {};
    if (d.allow) TEMP[jid][who] = Date.now();
    else delete TEMP[jid][who];
    return d.allow ? "okay, I'll reply " + who : "okay, I'll ignore " + who;
  }

  if (action === "stop") {
    writeFileAtomic(STOP_FILE, "1");
    return "stopping…";
  }

  throw new BadRequest("unknown action");
}

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

function authorized(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(TOOL_TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function allowedHost(host) {
  const address = server.address();
  const port = (address && typeof address === "object" ? address.port : null) || PORT;
  return host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}`;
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/health/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, status: "alive" }));
    return;
  }
  if (req.method !== "POST") {
    req.resume();
    return sendJson(res, 405, { ok: false, msg: "method not allowed" });
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

server.listen(PORT, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : PORT;
  console.log(`⚙️ Liam's tool endpoint is live on :${port}`);
});

const sync = require("./supabase_sync");
sync.restoreDb(DATA_DIR).then(() => sync.restoreSession(DATA_DIR, SESSION_DIR)).then(() => {
  sync.startPeriodicBackup(DATA_DIR);
  // periodic db backup
  setInterval(() => { sync.backupDb(); }, 10 * 60 * 1000);
  client.initialize();
}).catch(() => client.initialize());

module.exports = {
  server,
  client,
  sweepTimer,
  outboundLog,
  handleAction,
  normalizeRecipient,
  normalizeGroup,
  assertAllowed,
  assertOutbox,
  audioMime,
  authorized,
};
