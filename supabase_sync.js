const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "liam-session";
const SESSION_ARCHIVE = "session.tar.gz";
const DB_ARCHIVE = "liam_memory.db";
const FETCH_TIMEOUT_MS = Number.parseInt(process.env.LIAM_SUPABASE_TIMEOUT_MS || "120000", 10);
const MAX_ARCHIVE_BYTES = Math.max(
  16 * 1024 * 1024,
  Number.parseInt(process.env.LIAM_MAX_ARCHIVE_BYTES || String(300 * 1024 * 1024), 10),
);
const MAX_DB_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 250000;
const CHROME_LOCK_NAMES = new Set([
  "SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile", "LOCK",
  "DevToolsActivePort", "RunningChromeVersion",
]);

// Chromium caches are large, disposable, and change constantly. Excluding them
// keeps the free-tier Supabase archive small enough to restore quickly.
//
// Do NOT exclude IndexedDB or the Service Worker database: WhatsApp Web keeps
// the actual login inside them, so dropping those makes the restored profile
// look linked but fail to authenticate.
const CACHE_EXCLUDES = [
  "Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache",
  "DawnWebGPUCache", "GrShaderCache", "ShaderCache", "Media Cache",
  "Application Cache", "blob_storage", "Service Worker/CacheStorage",
  "Service Worker/ScriptCache", "Crashpad", "BrowserMetrics*",
  "GPUPersistentCache", "component_crx_cache", "extensions_crx_cache",
  "AutofillAiModelCache",
];

function configured() {
  return !!(SUPABASE_URL && SUPABASE_SECRET_KEY);
}

function baseDir(dataDir) {
  return dataDir || process.env.LIAM_DATA_DIR || "/data";
}

function defaultDbFile(dataDir) {
  return process.env.LIAM_DB || path.join(baseDir(dataDir), DB_ARCHIVE);
}

function defaultSessionDir(dataDir) {
  return path.join(baseDir(dataDir), "liam_session");
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        err.stdout = stdout;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

async function supabaseFetch(p, opts = {}) {
  if (!configured()) return null;
  const url = SUPABASE_URL + p;
  const headers = Object.assign({
    apikey: SUPABASE_SECRET_KEY,
    Authorization: "Bearer " + SUPABASE_SECRET_KEY,
  }, opts.headers || {});
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(5000, FETCH_TIMEOUT_MS));
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, Object.assign({}, opts, { headers, signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

let bucketReady = false;
async function ensureBucket() {
  if (!configured() || bucketReady) return;
  try {
    const res = await supabaseFetch("/storage/v1/bucket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: SUPABASE_BUCKET, name: SUPABASE_BUCKET, public: false }),
    });
    // 400/409 mean the bucket already exists; both are fine.
    if (!res || res.ok || res.status === 400 || res.status === 409) bucketReady = true;
  } catch (e) {
    // The upload itself will report the real error.
  }
}

function sanitizeChromeLocks(rootDir) {
  let removed = 0;
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (CHROME_LOCK_NAMES.has(entry.name)) {
        try { fs.rmSync(full, { force: true }); removed++; } catch (e) {}
      }
    }
  };
  if (rootDir && fs.existsSync(rootDir)) visit(rootDir);
  return removed;
}

async function downloadToFile(res, dest, maxBytes) {
  const declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`remote object too large (${declared} bytes)`);
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new Error(`remote object too large (over ${maxBytes} bytes)`));
      callback(null, chunk);
    },
  });
  try {
    if (res.body) {
      await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(dest, { mode: 0o600 }));
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error("remote object too large");
      fs.writeFileSync(dest, buf, { mode: 0o600 });
    }
    try { fs.chmodSync(dest, 0o600); } catch (e) {}
  } catch (e) {
    try { fs.rmSync(dest, { force: true }); } catch (e2) {}
    throw e;
  }
}

async function uploadPath(objectName, file, contentType) {
  await ensureBucket();
  const stat = fs.statSync(file);
  const urlPath = "/storage/v1/object/" + encodeURIComponent(SUPABASE_BUCKET) + "/" + encodeURIComponent(objectName);
  const attempt = async (body, headers) => supabaseFetch(urlPath, {
    method: "POST",
    headers: Object.assign({
      "Content-Type": contentType,
      "x-upsert": "true",
      "Content-Length": String(stat.size),
    }, headers || {}),
    body,
    ...(body && typeof body.pipe === "function" ? { duplex: "half" } : {}),
  });
  let res = null;
  try {
    res = await attempt(fs.createReadStream(file));
  } catch (e) {
    // Some HTTP stacks refuse streamed bodies; fall back to a buffer when it
    // is safe (the DB is small; sessions are only buffered under 300 MB).
    if (stat.size > MAX_ARCHIVE_BYTES) throw e;
    res = await attempt(fs.readFileSync(file));
  }
  if (res && res.ok) return { ok: true };
  const reason = res ? `status ${res.status}` : "no response";
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// SQLite: WAL-safe snapshots
// ---------------------------------------------------------------------------
function sqliteVacuumScript() {
  return "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('VACUUM INTO ?', (sys.argv[2],)); c.close()";
}

async function vacuumInto(dbFile, outFile) {
  try { fs.rmSync(outFile, { force: true }); } catch (e) {}
  const escaped = outFile.replace(/'/g, "''");
  try {
    await execFileAsync("sqlite3", [dbFile, `PRAGMA busy_timeout=10000; VACUUM INTO '${escaped}';`], { timeout: 90000 });
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 0) return outFile;
  } catch (e) {
    // Fall through to Python.
  }
  const python = process.env.LIAM_PYTHON || (process.platform === "win32" ? "python" : "python3");
  await execFileAsync(python, ["-c", sqliteVacuumScript(), dbFile, outFile], { timeout: 90000 });
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size <= 0) {
    throw new Error("VACUUM INTO produced no file");
  }
  return outFile;
}

function looksLikeSqlite(file) {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const header = Buffer.alloc(16);
      const read = fs.readSync(fd, header, 0, header.length, 0);
      return read === 16 && header.toString("utf8") === "SQLite format 3\u0000";
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return false;
  }
}

async function restoreDb(dataDir) {
  if (!configured()) return { restored: false, reason: "not configured" };
  const dbFile = defaultDbFile(dataDir);
  const tmp = dbFile + ".restore.tmp";
  try {
    const res = await supabaseFetch("/storage/v1/object/" + encodeURIComponent(SUPABASE_BUCKET) + "/" + DB_ARCHIVE);
    if (!res || !res.ok) {
      console.log("info: no remote db");
      return { restored: false, reason: res ? `status ${res.status}` : "no response" };
    }
    await downloadToFile(res, tmp, MAX_DB_BYTES);
    if (!looksLikeSqlite(tmp)) throw new Error("remote db is not a SQLite database");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.rmSync(dbFile + suffix, { force: true }); } catch (e) {}
    }
    fs.renameSync(tmp, dbFile);
    try { fs.chmodSync(dbFile, 0o600); } catch (e) {}
    console.log("db restored from Supabase");
    return { restored: true, path: dbFile };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (e2) {}
    console.log("warn: db restore failed:", String(e && e.message ? e.message : e));
    return { restored: false, error: String(e && e.message ? e.message : e) };
  }
}

async function backupDb(dataDir) {
  if (!configured()) return { ok: false, reason: "not configured" };
  const dbFile = defaultDbFile(dataDir);
  const tmp = dbFile + ".vacuum.tmp";
  try {
    if (!fs.existsSync(dbFile)) return { ok: false, reason: "no db file" };
    await vacuumInto(dbFile, tmp);
    const size = fs.statSync(tmp).size;
    if (size > MAX_DB_BYTES) return { ok: false, reason: "db too large" };
    const result = await uploadPath(DB_ARCHIVE, tmp, "application/octet-stream");
    if (result.ok) { console.log("db backed up to Supabase"); return { ok: true }; }
    console.log("warn: db backup failed:", result.reason);
    return result;
  } catch (e) {
    console.log("warn: db backup failed:", String(e && e.message ? e.message : e));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Session archive: cache-excluded, validated against traversal, atomic restore
// ---------------------------------------------------------------------------
function archiveExcludes(sessionName) {
  const root = `${sessionName}/session`;
  const excludes = [];
  // Chromium nests caches under Default/ as well as the profile root, so match
  // the cache name at any depth instead of only directly under the profile.
  for (const cache of CACHE_EXCLUDES) excludes.push(`--exclude=*/${cache}`);
  for (const cache of CACHE_EXCLUDES) {
    if (!cache.includes("/")) excludes.push(`--exclude=${root}/${cache}`);
  }
  for (const lock of CHROME_LOCK_NAMES) {
    excludes.push(`--exclude=*/${lock}`);
  }
  return excludes;
}

function unsafeEntry(entry) {
  const value = String(entry || "");
  if (!value || value.includes("\0")) return true;
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return true;
  const parts = value.split(/[\\/]+/);
  return parts.includes("..");
}

async function validateArchive(archiveFile, sessionName) {
  const listing = await execFileAsync("tar", ["-tzf", archiveFile], { timeout: 60000 });
  const entries = String(listing.stdout || "").split(/\r?\n/).filter(Boolean);
  if (!entries.length) throw new Error("archive is empty");
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error("archive has too many entries");
  const top = sessionName + "/";
  for (const entry of entries) {
    if (unsafeEntry(entry)) throw new Error(`unsafe archive entry: ${entry}`);
    if (entry !== sessionName && !entry.startsWith(top)) {
      throw new Error(`archive entry is outside ${sessionName}: ${entry}`);
    }
  }
  const verbose = await execFileAsync("tar", ["-tvzf", archiveFile], { timeout: 60000 });
  // The first column is the tar type flag: `l` is a symlink and `h` a hard
  // link. Do not inspect names for "->": a legitimate file could contain it.
  for (const line of String(verbose.stdout || "").split(/\r?\n/)) {
    if (/^[lh]/i.test(line)) throw new Error("archive contains a link entry");
  }
  return entries.length;
}

async function restoreSession(dataDir, sessionDir) {
  if (!configured()) return { restored: false, reason: "not configured" };
  const base = baseDir(dataDir);
  const targetSession = sessionDir || defaultSessionDir(base);
  const sessionName = path.basename(targetSession);
  const tmp = path.join(base, SESSION_ARCHIVE + ".restore.tmp");
  let staging = null;
  try {
    const res = await supabaseFetch("/storage/v1/object/" + encodeURIComponent(SUPABASE_BUCKET) + "/" + SESSION_ARCHIVE);
    if (!res || !res.ok) {
      console.log("info: no remote session archive");
      return { restored: false, reason: res ? `status ${res.status}` : "no response" };
    }
    fs.mkdirSync(base, { recursive: true });
    await downloadToFile(res, tmp, MAX_ARCHIVE_BYTES);
    const entryCount = await validateArchive(tmp, sessionName);

    staging = fs.mkdtempSync(path.join(base, ".restore-"));
    await execFileAsync("tar", ["-xzf", tmp, "-C", staging], { timeout: 180000 });
    const extracted = path.join(staging, sessionName);
    if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) {
      throw new Error("archive did not contain the session directory");
    }
    sanitizeChromeLocks(extracted);

    const old = targetSession + ".old." + Date.now();
    const hadOld = fs.existsSync(targetSession);
    if (hadOld) fs.renameSync(targetSession, old);
    try {
      fs.renameSync(extracted, targetSession);
    } catch (e) {
      if (hadOld) { try { fs.renameSync(old, targetSession); } catch (e2) {} }
      throw e;
    }
    if (hadOld) { try { fs.rmSync(old, { recursive: true, force: true }); } catch (e) {} }
    try { fs.chmodSync(targetSession, 0o700); } catch (e) {}

    console.log(`session restored from Supabase (${entryCount} entries)`);
    return { restored: true, entries: entryCount };
  } catch (e) {
    console.log("warn: session restore failed:", String(e && e.message ? e.message : e));
    return { restored: false, error: String(e && e.message ? e.message : e) };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) {} }
  }
}

async function backupSession(dataDir, sessionDir) {
  if (!configured()) return { ok: false, reason: "not configured" };
  const base = baseDir(dataDir);
  const targetSession = sessionDir || defaultSessionDir(base);
  if (!fs.existsSync(targetSession)) return { ok: false, reason: "no session dir" };
  const sessionName = path.basename(targetSession);
  const tmp = path.join(base, SESSION_ARCHIVE + ".backup.tmp");
  try {
    await execFileAsync("tar", [
      "-czf", tmp,
      ...archiveExcludes(sessionName),
      "-C", base, sessionName,
    ], { timeout: 240000 });
    const size = fs.statSync(tmp).size;
    if (size > MAX_ARCHIVE_BYTES) return { ok: false, reason: "archive too large" };
    const result = await uploadPath(SESSION_ARCHIVE, tmp, "application/gzip");
    if (result.ok) { console.log(`session backed up to Supabase (${Math.round(size / 1024 / 1024)} MiB)`); return { ok: true, bytes: size }; }
    console.log("warn: session backup failed:", result.reason);
    return result;
  } catch (e) {
    console.log("warn: session backup failed:", String(e && e.message ? e.message : e));
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
  }
}

let backupTimer = null;
let backupRunning = false;

async function backupNow(dataDir, sessionDir, dbDir) {
  if (!configured()) return { ok: false, reason: "not configured" };
  if (backupRunning) return { ok: false, reason: "backup already running" };
  backupRunning = true;
  try {
    const session = await backupSession(dataDir, sessionDir);
    const db = await backupDb(dbDir || dataDir);
    return { ok: !!(session.ok || db.ok), session, db };
  } finally {
    backupRunning = false;
  }
}

function startPeriodicBackup(dataDir, sessionDir, dbDir) {
  if (backupTimer) return backupTimer;
  const intervalMs = Math.max(60_000, Number.parseInt(process.env.LIAM_BACKUP_INTERVAL_MS || "600000", 10));
  const run = async () => {
    try { await backupNow(dataDir, sessionDir, dbDir); }
    catch (e) { console.log("warn: periodic backup failed:", String(e)); }
  };
  backupTimer = setInterval(run, intervalMs);
  if (typeof backupTimer.unref === "function") backupTimer.unref();
  return backupTimer;
}

function stopPeriodicBackup() {
  if (backupTimer) clearInterval(backupTimer);
  backupTimer = null;
}

module.exports = {
  restoreSession, backupSession, restoreDb, backupDb, backupNow,
  sanitizeChromeLocks, startPeriodicBackup, stopPeriodicBackup,
  configured, vacuumInto, validateArchive, archiveExcludes, defaultDbFile,
  looksLikeSqlite, unsafeEntry, CACHE_EXCLUDES,
};
