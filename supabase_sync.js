const fs = require("fs");
const path = require("path");
const { execFile, spawn } = require("child_process");
const readline = require("readline");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");

// a mistyped numeric env var (e.g. "5m") must not be accepted as 5:
// Number.parseInt ignores trailing junk, and NaN in Math.max turns a timeout
// into an instant abort or a backup interval into a tight loop. only a whole
// decimal integer is accepted; anything else falls back to the default.
function envInt(name, fallback, min, max) {
  const raw = String(process.env[name] === undefined ? "" : process.env[name]).trim();
  const parsed = /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "liam-session";
const SESSION_ARCHIVE = "session.tar.gz";
const DB_ARCHIVE = "liam_memory.db";
const FETCH_TIMEOUT_MS = envInt("LIAM_SUPABASE_TIMEOUT_MS", 120000, 5000);
const MAX_ARCHIVE_BYTES = envInt("LIAM_MAX_ARCHIVE_BYTES", 300 * 1024 * 1024, 16 * 1024 * 1024);
const MAX_DB_BYTES = 200 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 250000;
// buffering a whole upload in memory is only safe for small, non-session
// objects; a 300 MB session archive can exhaust a 512 MB container.
const MAX_BUFFERED_UPLOAD_BYTES = 16 * 1024 * 1024;
// cap the sum of uncompressed member sizes so a tiny, highly compressible
// archive cannot fill /data during extraction.
const MAX_UNCOMPRESSED_BYTES = envInt("LIAM_MAX_UNCOMPRESSED_BYTES", 1024 * 1024 * 1024, 0);
// one retry layer with exponential backoff; env override keeps tests fast.
const UPLOAD_ATTEMPTS = 2;
const UPLOAD_RETRY_BASE_MS = envInt("LIAM_UPLOAD_RETRY_MS", 500, 0);
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
  const onAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, Object.assign({}, opts, { headers, signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
    // remove the listener so a long-lived caller's signal does not retain us.
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
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

// A profile counts as linked only when the completed-login marker is present and
// the stored credentials say "registered". Baileys writes creds.json before the
// phone confirms a code, so creds alone are not proof of a real login.
function sessionLooksLinked(sessionDir) {
  try {
    if (!fs.existsSync(path.join(sessionDir, "wa_linked.json"))) return false;
    const raw = fs.readFileSync(path.join(sessionDir, "session", "creds.json"), "utf8");
    const creds = JSON.parse(raw);
    return !!(creds && creds.registered);
  } catch (e) {
    return false;
  }
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

async function uploadOnce(urlPath, file, contentType, stat, canBuffer) {
  const attempt = async (body) => supabaseFetch(urlPath, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "x-upsert": "true",
      "Content-Length": String(stat.size),
    },
    body,
    ...(body && typeof body.pipe === "function" ? { duplex: "half" } : {}),
  });
  let stream = null;
  try {
    stream = fs.createReadStream(file);
    return await attempt(stream);
  } catch (e) {
    // some http stacks refuse streamed bodies; fall back to a small buffer
    // only for non-session objects. buffering a session archive (up to 300 MB)
    // can exhaust a 512 MB container, so those uploads fail instead.
    if (!canBuffer || stat.size > MAX_BUFFERED_UPLOAD_BYTES) throw e;
    return await attempt(fs.readFileSync(file));
  } finally {
    // a response may arrive before the request stream is fully consumed.
    if (stream) stream.destroy();
  }
}

// a dropped connection, a 5xx, or a 429 is transient. without a retry a single
// blip lost a whole backup cycle, and the next one is up to 30 minutes away.
// a permanent failure (auth, too large) is returned at once and not retried.
function transientUpload(res) {
  return !res || res.status === 429 || res.status >= 500;
}

async function uploadPath(objectName, file, contentType) {
  await ensureBucket();
  const stat = fs.statSync(file);
  const urlPath = "/storage/v1/object/" + encodeURIComponent(SUPABASE_BUCKET) + "/" + encodeURIComponent(objectName);
  const canBuffer = objectName !== SESSION_ARCHIVE;
  let lastError = null;
  let lastReason = "no response";
  // the only retry layer: one initial attempt plus exponentially spaced retries.
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(UPLOAD_RETRY_BASE_MS * 2 ** (attempt - 2));
    let res = null;
    try {
      res = await uploadOnce(urlPath, file, contentType, stat, canBuffer);
      lastError = null;
      lastReason = res ? `status ${res.status}` : "no response";
      if (res && res.ok) return { ok: true };
      if (!transientUpload(res)) return { ok: false, reason: lastReason };
    } catch (e) {
      // a thrown retry replaces any earlier status; never report a stale res.
      lastError = e;
      res = null;
    }
  }
  if (lastError) {
    const message = String(lastError && lastError.message ? lastError.message : lastError);
    return { ok: false, reason: message, error: message };
  }
  return { ok: false, reason: lastReason };
}

// Small JSON blobs (currently the bridge's held replies and group permissions)
// ride to Supabase the same way the session and DB do. On Render's free plan the
// disk is wiped on every redeploy, so Supabase is the only copy that survives.
const MAX_STATE_BYTES = envInt("LIAM_MAX_STATE_BYTES", 8 * 1024 * 1024, 0);

async function uploadState(dataDir, objectName, value) {
  if (!configured()) return { ok: false, reason: "not configured" };
  const base = baseDir(dataDir);
  let dir = null;
  try {
    fs.mkdirSync(base, { recursive: true });
    // a unique temp dir keeps a debounced save and a shutdown save from
    // clobbering each other's file during a redeploy.
    dir = fs.mkdtempSync(path.join(base, ".upload-"));
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > MAX_STATE_BYTES) {
      return { ok: false, reason: "state object too large" };
    }
    const tmp = path.join(dir, path.basename(objectName));
    fs.writeFileSync(tmp, json, { mode: 0o600 });
    return await uploadPath(objectName, tmp, "application/json");
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  }
}

async function downloadState(objectName) {
  if (!configured()) return { restored: false, reason: "not configured" };
  try {
    const res = await supabaseFetch("/storage/v1/object/" + encodeURIComponent(SUPABASE_BUCKET) + "/" + encodeURIComponent(objectName));
    if (!res || !res.ok) return { restored: false, reason: res ? `status ${res.status}` : "no response" };
    const declared = Number(res.headers && res.headers.get ? res.headers.get("content-length") : 0);
    if (Number.isFinite(declared) && declared > MAX_STATE_BYTES) {
      return { restored: false, reason: "state object too large" };
    }
    const text = await res.text();
    // text.length counts UTF-16 units, not bytes; emoji need up to 4 UTF-8 bytes.
    if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
      return { restored: false, reason: "state object too large" };
    }
    return { restored: true, value: JSON.parse(text) };
  } catch (e) {
    return { restored: false, error: String(e && e.message ? e.message : e) };
  }
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

async function sqliteIntegrityOk(file) {
  const python = process.env.LIAM_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const script = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('PRAGMA integrity_check').fetchone()[0])";
  try {
    const result = await execFileAsync(python, ["-c", script, file], { timeout: 120000 });
    return String(result.stdout || "").trim() === "ok";
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
    // the 16-byte magic alone cannot detect a truncated or corrupt cloud copy.
    if (!(await sqliteIntegrityOk(tmp))) throw new Error("remote db failed SQLite integrity_check");
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    for (const suffix of ["-wal", "-shm"]) {
      try { fs.rmSync(dbFile + suffix, { force: true }); } catch (e) {}
    }
    // memory is not safely re-derivable after a bad restore; keep a copy.
    if (fs.existsSync(dbFile)) {
      const rollback = dbFile + ".old." + Date.now();
      try { fs.copyFileSync(dbFile, rollback); }
      catch (e) { throw new Error("could not keep a db rollback copy: " + (e && e.message ? e.message : e)); }
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

// metadata is written one json line per member and streamed to a file: a
// 250k-entry `tar -tvzf` listing overflows a fixed 64 MB exec buffer.
const ARCHIVE_LIST_SCRIPT = String.raw`
import json, sys, tarfile
with tarfile.open(sys.argv[1], "r:gz") as tf:
    for m in tf:
        print(json.dumps({"name": m.name, "type": m.type.decode("ascii"), "size": m.size}))
`;

async function validateArchive(archiveFile, sessionName) {
  const python = process.env.LIAM_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const listing = archiveFile + ".listing.tmp";
  const child = spawn(python, ["-c", ARCHIVE_LIST_SCRIPT, archiveFile]);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 8192) stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`archive listing failed (status ${code}): ${stderr.trim()}`));
    });
  });
  const result = { entries: 0, links: 0, uncompressedBytes: 0 };
  const top = sessionName + "/";
  try {
    await Promise.all([pipeline(child.stdout, fs.createWriteStream(listing)), exited]);
    const input = fs.createReadStream(listing);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.trim()) continue;
        const member = JSON.parse(line);
        const name = String(member.name || "");
        result.entries += 1;
        if (result.entries > MAX_ARCHIVE_ENTRIES) throw new Error("archive has too many entries");
        if (unsafeEntry(name)) throw new Error(`unsafe archive entry: ${name}`);
        if (name !== sessionName && !name.startsWith(top)) {
          throw new Error(`archive entry is outside ${sessionName}: ${name}`);
        }
        // any type other than regular file ("0") or directory ("5") is
        // special: links, devices, fifos and sockets all need safe extraction.
        if (member.type !== "0" && member.type !== "5") result.links += 1;
        result.uncompressedBytes += Number(member.size) || 0;
        if (result.uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
          throw new Error(`archive expands beyond ${MAX_UNCOMPRESSED_BYTES} bytes`);
        }
      }
    } finally {
      rl.close();
      input.destroy();
    }
    if (!result.entries) throw new Error("archive is empty");
    return result;
  } finally {
    child.kill();
    try { fs.rmSync(listing, { force: true }); } catch (e) {}
  }
}

// Extract a profile without ever creating a symlink, hard link, device, fifo or
// socket. This is used for archives that contain special entries; they are
// skipped and every regular file is still restored safely inside staging.
const EXTRACT_LINKS_SCRIPT = String.raw`
import json, os, sys, tarfile

archive = sys.argv[1]
dest = os.path.abspath(sys.argv[2])
root = os.path.realpath(dest)
files = dirs = skipped = 0

def safe_target(name):
    normalized = name.replace("\\", "/")
    parts = [part for part in normalized.split("/") if part not in ("", ".")]
    if normalized.startswith(("/", "\\")) or (len(normalized) > 1 and normalized[1] == ":"):
        raise SystemExit("unsafe archive entry: " + name)
    if ".." in parts:
        raise SystemExit("unsafe archive entry: " + name)
    target = os.path.realpath(os.path.join(root, *parts))
    if target != root and not target.startswith(root + os.sep):
        raise SystemExit("archive entry escapes destination: " + name)
    return target

with tarfile.open(archive, "r:gz") as tf:
    for member in tf:
        target = safe_target(member.name)
        if member.issym() or member.islnk() or member.isdev() or member.isfifo() or member.type == b"s":
            skipped += 1
            continue
        if member.isdir():
            os.makedirs(target, exist_ok=True)
            try:
                os.chmod(target, 0o700)
            except OSError:
                pass
            dirs += 1
            continue
        if not member.isfile():
            skipped += 1
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        source = tf.extractfile(member)
        if source is None:
            skipped += 1
            continue
        with open(target, "wb") as handle:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
        try:
            os.chmod(target, 0o600)
        except OSError:
            pass
        files += 1

print(json.dumps({"files": files, "dirs": dirs, "skipped": skipped}))
`;

async function extractArchiveWithoutLinks(archiveFile, destination) {
  const python = process.env.LIAM_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const result = await execFileAsync(
    python, ["-c", EXTRACT_LINKS_SCRIPT, archiveFile, destination], { timeout: 180000 });
  const line = String(result.stdout || "").trim().split(/\r?\n/).pop() || "{}";
  return JSON.parse(line);
}

// a crash between moving the old session aside and installing the new one
// leaves no profile; boot restore puts the most recent .old. copy back.
function recoverInterruptedSessionSwap(targetSession) {
  if (fs.existsSync(targetSession)) return;
  const parent = path.dirname(targetSession);
  const name = path.basename(targetSession);
  let old = null;
  try {
    old = fs.readdirSync(parent)
      .filter((entry) => entry.startsWith(name + ".old."))
      .sort()
      .pop();
  } catch (e) { return; }
  if (!old) return;
  try {
    fs.renameSync(path.join(parent, old), targetSession);
    console.log(`info: recovered session from ${old}`);
  } catch (e) {}
}

async function restoreSession(dataDir, sessionDir) {
  if (!configured()) return { restored: false, reason: "not configured" };
  const base = baseDir(dataDir);
  const targetSession = sessionDir || defaultSessionDir(base);
  recoverInterruptedSessionSwap(targetSession);
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
    const archiveInfo = await validateArchive(tmp, sessionName);

    staging = fs.mkdtempSync(path.join(base, ".restore-"));
    if (archiveInfo.links > 0) {
      const detail = await extractArchiveWithoutLinks(tmp, staging);
      console.log(
        `session archive contained ${archiveInfo.links} special entries; ` +
        `skipped them safely (${detail.files || 0} files restored)`);
    } else {
      await execFileAsync("tar", ["-xzf", tmp, "-C", staging], { timeout: 180000 });
    }
    const extracted = path.join(staging, sessionName);
    if (!fs.existsSync(extracted) || !fs.statSync(extracted).isDirectory()) {
      throw new Error("archive did not contain the session directory");
    }
    sanitizeChromeLocks(extracted);

    // custom sessionDir values can be nested deeper than the data dir.
    fs.mkdirSync(path.dirname(targetSession), { recursive: true });
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

    console.log(`session restored from Supabase (${archiveInfo.entries} entries)`);
    return { restored: true, entries: archiveInfo.entries, skippedLinks: archiveInfo.links };
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
  // Never replace a good cloud copy with an unlinked profile. After a wipe (or
  // before a link) the local profile still has a creds.json, so this checks the
  // completed-login marker and the registered flag, not just file existence.
  if (!sessionLooksLinked(targetSession)) {
    console.log("info: session is not linked; keeping the previous cloud copy");
    return { ok: false, skipped: true, reason: "session not linked" };
  }
  const sessionName = path.basename(targetSession);
  const tmp = path.join(base, SESSION_ARCHIVE + ".backup.tmp");
  try {
    // Dereference links so the archive contains only normal files. On Linux
    // GNU tar also needs --hard-dereference to turn hard links into files.
    const args = ["-czf", tmp, "--dereference"];
    if (process.platform === "linux") args.push("--hard-dereference");
    args.push(...archiveExcludes(sessionName), "-C", base, sessionName);
    await execFileAsync("tar", args, { timeout: 240000 });
    const size = fs.statSync(tmp).size;
    if (size > MAX_ARCHIVE_BYTES) return { ok: false, reason: "archive too large" };
    // Never replace a good cloud copy with an archive we cannot restore.
    const info = await validateArchive(tmp, sessionName);
    if (info.links) {
      throw new Error(
        `refusing to upload an archive with ${info.links} link entries; ` +
        "the previous cloud copy was kept");
    }
    const result = await uploadPath(SESSION_ARCHIVE, tmp, "application/gzip");
    if (result.ok) {
      console.log(`session backed up to Supabase (${Math.round(size / 1024 / 1024)} MiB)`);
      return { ok: true, bytes: size, entries: info.entries };
    }
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

// The periodic backup exists to survive a free-instance restart, not to churn
// the CPU every cycle. On an idle Liam nothing changes between runs, so we
// compare a cheap signature and skip the tar/gzip/vacuum work when it matches.
let lastBackupSig = { session: "", db: "" };

function statSig(file) {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch (e) {
    return "";
  }
}

const CACHE_SEGMENTS = new Set(
  CACHE_EXCLUDES.map((n) => n.split("/").pop().toLowerCase()).filter((n) => !n.includes("*")),
);
const CACHE_PREFIXES = CACHE_EXCLUDES
  .filter((n) => n.endsWith("*"))
  .map((n) => n.split("/").pop().slice(0, -1).toLowerCase());

// a sorted per-path list catches same-size content changes even when the
// newest mtime does not move; full mtimeMs precision catches sub-ms edits.
// caches and locks the archive drops are skipped, as before.
function sessionSignature(dir) {
  const parts = [];
  const walk = (current, rel) => {
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (e) { return; }
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      const relPath = rel ? rel + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (CACHE_SEGMENTS.has(lower)) continue;
        if (CACHE_PREFIXES.some((p) => p && lower.startsWith(p))) continue;
        walk(path.join(current, entry.name), relPath);
        continue;
      }
      if (CHROME_LOCK_NAMES.has(entry.name)) continue;
      try {
        const s = fs.statSync(path.join(current, entry.name));
        parts.push(`${relPath}:${s.size}:${s.mtimeMs}`);
      } catch (e) {}
    }
  };
  walk(dir, "");
  parts.sort();
  return parts.join("|");
}

async function backupNow(dataDir, sessionDir, dbDir, options = {}) {
  if (!configured()) return { ok: false, reason: "not configured" };
  if (backupRunning) return { ok: false, reason: "backup already running" };
  const force = options.force === true;
  backupRunning = true;
  try {
    const base = baseDir(dataDir);
    const targetSession = sessionDir || defaultSessionDir(base);
    const dbFile = defaultDbFile(dbDir || dataDir);

    // Before WhatsApp is linked the profile is disposable. Uploading it would
    // overwrite the last good session in Supabase with an empty one.
    let session;
    if (options.session === false) {
      session = { ok: false, skipped: true, reason: "session not ready" };
    } else {
      const sig = sessionLooksLinked(targetSession) ? sessionSignature(targetSession) : "";
      if (!force && sig && sig === lastBackupSig.session) {
        session = { ok: false, skipped: true, reason: "session unchanged" };
      } else {
        session = await backupSession(dataDir, sessionDir);
        if (session.ok) lastBackupSig.session = sig || sessionSignature(targetSession);
      }
    }

    let db;
    const dbSig = statSig(dbFile);
    if (!force && dbSig && dbSig === lastBackupSig.db) {
      db = { ok: false, skipped: true, reason: "db unchanged" };
    } else {
      db = await backupDb(dbDir || dataDir);
      if (db.ok) lastBackupSig.db = dbSig;
    }
    return { ok: !!(session.ok || db.ok), session, db };
  } finally {
    backupRunning = false;
  }
}

function startPeriodicBackup(dataDir, sessionDir, dbDir) {
  if (backupTimer) return backupTimer;
  const intervalMs = envInt("LIAM_BACKUP_INTERVAL_MS", 600000, 60000);
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
  looksLikeSqlite, unsafeEntry, CACHE_EXCLUDES, sessionLooksLinked,
  sessionSignature, uploadState, downloadState, uploadPath, envInt,
};
