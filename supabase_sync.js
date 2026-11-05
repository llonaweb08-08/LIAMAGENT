const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "liam-session";
const SESSION_ARCHIVE = "session.tar.gz";

async function supabaseFetch(p, opts) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return null;
  const url = SUPABASE_URL + p;
  const headers = Object.assign({ "apikey": SUPABASE_SECRET_KEY, "Authorization": "Bearer " + SUPABASE_SECRET_KEY }, (opts && opts.headers) || {});
  const res = await fetch(url, Object.assign({}, opts || {}, { headers }));
  return res;
}

const DB_FILE = process.env.LIAM_DB || (process.env.LIAM_DATA_DIR ? (process.env.LIAM_DATA_DIR + "/liam_memory.db") : "/data/liam_memory.db");
const DB_ARCHIVE = "liam_memory.db";

async function restoreDb(DATA_DIR) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  try {
    const res = await supabaseFetch("/storage/v1/object/" + SUPABASE_BUCKET + "/" + DB_ARCHIVE);
    if (!res || !res.ok) { console.log("info: no remote db"); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(DB_FILE, buf);
    console.log("db restored from Supabase");
  } catch (e) { console.log("warn: db restore failed:", String(e)); }
}

async function backupDb() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const buf = fs.readFileSync(DB_FILE);
    const res = await supabaseFetch("/storage/v1/object/" + SUPABASE_BUCKET + "/" + DB_ARCHIVE, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream", "x-upsert": "true" },
      body: buf,
    });
    if (res && res.ok) console.log("db backed up to Supabase");
    else console.log("warn: db backup failed:", res && res.status);
  } catch (e) { console.log("warn: db backup failed:", String(e)); }
}
async function restoreSession(DATA_DIR, SESSION_DIR) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  try {
    const res = await supabaseFetch("/storage/v1/object/" + SUPABASE_BUCKET + "/" + SESSION_ARCHIVE);
    if (!res || !res.ok) { console.log("info: no remote session archive"); return; }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = path.join(DATA_DIR, SESSION_ARCHIVE);
    fs.writeFileSync(tmp, buf);
    execSync("tar -xzf " + JSON.stringify(tmp) + " -C " + JSON.stringify(DATA_DIR), { stdio: "ignore" });
    fs.rmSync(tmp, { force: true });
    console.log("session restored from Supabase");
  } catch (e) { console.log("warn: session restore failed:", String(e)); }
}

async function backupSession(DATA_DIR) {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) return;
  try {
    const tmp = path.join(DATA_DIR, SESSION_ARCHIVE);
    execSync("tar -czf " + JSON.stringify(tmp) + " -C " + JSON.stringify(DATA_DIR) + " liam_session", { stdio: "ignore" });
    const buf = fs.readFileSync(tmp);
    const res = await supabaseFetch("/storage/v1/object/" + SUPABASE_BUCKET + "/" + SESSION_ARCHIVE, {
      method: "POST",
      headers: { "Content-Type": "application/gzip", "x-upsert": "true" },
      body: buf,
    });
    fs.rmSync(tmp, { force: true });
    if (res && res.ok) console.log("session backed up to Supabase");
    else console.log("warn: session backup failed:", res && res.status);
  } catch (e) { console.log("warn: session backup failed:", String(e)); }
}

function startPeriodicBackup(DATA_DIR) {
  setInterval(() => { backupSession(DATA_DIR); backupDb(); }, 10 * 60 * 1000);
}

module.exports = { restoreSession, backupSession, restoreDb, backupDb, startPeriodicBackup };