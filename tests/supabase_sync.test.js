'use strict';

// Exercises Supabase archive/snapshot handling against a local mock storage
// server. No real Supabase project, WhatsApp session, or network is used.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const PYTHON = process.env.LIAM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'liam-sync-test-'));
const objects = new Map();
let server;
let sync;

function startMockSupabase() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (req.method === 'POST' && pathname === '/storage/v1/bucket') {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const match = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(pathname);
      if (!match) {
        req.resume();
        res.writeHead(404);
        res.end();
        return;
      }
      const name = match[2];
      if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
          objects.set(name, Buffer.concat(chunks));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{}');
        });
        return;
      }
      if (req.method === 'GET') {
        const body = objects.get(name);
        if (!body) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(body.length),
        });
        res.end(body);
        return;
      }
      req.resume();
      res.writeHead(405);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function writeProfile(base) {
  const session = path.join(base, 'liam_session', 'session');
  const files = {
    'Local State': '{}',
    'Default/Preferences': '{}',
    'Default/Local Storage/leveldb/CURRENT': 'leveldb',
    'Default/IndexedDB/https_web.whatsapp.com_0.indexeddb.leveldb/CURRENT': 'indexeddb',
    'Default/Service Worker/Database/CURRENT': 'service-worker',
    'Default/Cache/data_0': 'x'.repeat(4096),
    'Default/Code Cache/js/data_0': 'y'.repeat(4096),
    'Default/GPUCache/data_0': 'z'.repeat(4096),
    'Default/lockfile': 'lock',
    'SingletonLock': 'lock',
  };
  for (const [name, value] of Object.entries(files)) {
    const file = path.join(session, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
  }
  return session;
}

function writeTar(file, entries) {
  // Python's tarfile can create traversal and symlink entries without needing
  // those links to exist on the host filesystem.
  const script = [
    'import sys, tarfile',
    'path = sys.argv[1]',
    'with tarfile.open(path, "w:gz") as t:',
    '    for name, kind, target in [',
    '        ["../evil", "file", ""],',
    '        ["liam_session/session/link", "symlink", "/etc/passwd"],',
    '    ]:',
    '        info = tarfile.TarInfo(name)',
    '        if kind == "symlink":',
    '            info.type = tarfile.SYMTYPE',
    '            info.linkname = target',
    '            t.addfile(info)',
    '        else:',
    '            data = b"evil"',
    '            info.size = len(data)',
    '            import io',
    '            t.addfile(info, io.BytesIO(data))',
  ].join('\n');
  execFileSync(PYTHON, ['-c', script, file]);
}

function sqliteRows(file) {
  const script = 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select count(*) from t").fetchone()[0])';
  return execFileSync(PYTHON, ['-c', script, file], { encoding: 'utf8' }).trim();
}

test('supabase session and database persistence', async (t) => {
  const port = await startMockSupabase();
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.SUPABASE_STORAGE_BUCKET = 'liam-session';
  process.env.LIAM_SUPABASE_TIMEOUT_MS = '30000';
  sync = require('../supabase_sync');

  await t.test('recognises unsafe archive entries', () => {
    assert.equal(sync.unsafeEntry('../evil'), true);
    assert.equal(sync.unsafeEntry('/etc/passwd'), true);
    assert.equal(sync.unsafeEntry('C:/Windows/win.ini'), true);
    assert.equal(sync.unsafeEntry('liam_session/../../evil'), true);
    assert.equal(sync.unsafeEntry('liam_session/session/Preferences'), false);
  });

  await t.test('detects the SQLite file header', () => {
    const db = path.join(TMP, 'header.db');
    execFileSync(PYTHON, ['-c', 'import sqlite3,sys; sqlite3.connect(sys.argv[1]).execute("create table t(x)").connection.commit()', db]);
    assert.equal(sync.looksLikeSqlite(db), true);
    fs.writeFileSync(path.join(TMP, 'not.db'), '<html>not a db</html>');
    assert.equal(sync.looksLikeSqlite(path.join(TMP, 'not.db')), false);
  });

  await t.test('removes stale Chrome lock files but not profile data', () => {
    const base = path.join(TMP, 'locks');
    writeProfile(base);
    const removed = sync.sanitizeChromeLocks(path.join(base, 'liam_session'));
    assert.ok(removed >= 2);
    assert.equal(fs.existsSync(path.join(base, 'liam_session/session/Default/Preferences')), true);
  });

  await t.test('archives the profile without caches or locks', async () => {
    const base = path.join(TMP, 'source');
    writeProfile(base);
    const result = await sync.backupSession(base);
    assert.equal(result.ok, true);
    assert.ok(result.bytes > 0);

    const archive = path.join(TMP, 'session.tar.gz');
    fs.writeFileSync(archive, objects.get('session.tar.gz'));
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.match(listing, /Default\/IndexedDB\//);
    assert.match(listing, /Default\/Local Storage\//);
    assert.doesNotMatch(listing, /Default\/Cache\//);
    assert.doesNotMatch(listing, /Default\/Code Cache\//);
    assert.doesNotMatch(listing, /Default\/GPUCache\//);
    assert.doesNotMatch(listing, /lockfile|SingletonLock/);
  });

  await t.test('restores the archive into a new data directory', async () => {
    const target = path.join(TMP, 'restored');
    const result = await sync.restoreSession(target);
    assert.equal(result.restored, true);
    assert.ok(result.entries > 0);
    const session = path.join(target, 'liam_session', 'session');
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Preferences')), true);
    assert.equal(fs.existsSync(path.join(session, 'Default', 'IndexedDB')), true);
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Cache')), false);
    assert.equal(fs.existsSync(path.join(session, 'SingletonLock')), false);
  });

  await t.test('rejects an archive with traversal or symlink entries', async () => {
    const archive = path.join(TMP, 'unsafe.tar.gz');
    writeTar(archive, []);
    objects.set('session.tar.gz', fs.readFileSync(archive));
    const target = path.join(TMP, 'unsafe-restore');
    const result = await sync.restoreSession(target);
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /unsafe archive entry|link entry/);
    assert.equal(fs.existsSync(path.join(TMP, 'evil')), false);
  });

  await t.test('backs up a WAL-safe database and restores it', async () => {
    const source = path.join(TMP, 'db-source');
    fs.mkdirSync(source, { recursive: true });
    const dbFile = path.join(source, 'liam_memory.db');
    execFileSync(PYTHON, ['-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.execute("insert into t values (1)"); c.commit()',
      dbFile]);
    process.env.LIAM_DB = dbFile;
    const backup = await sync.backupDb(source);
    assert.equal(backup.ok, true);
    assert.ok(objects.get('liam_memory.db').length > 0);

    const target = path.join(TMP, 'db-restore');
    fs.mkdirSync(target, { recursive: true });
    const restored = path.join(target, 'liam_memory.db');
    process.env.LIAM_DB = restored;
    const result = await sync.restoreDb(target);
    assert.equal(result.restored, true);
    assert.equal(sqliteRows(restored), '1');
  });

  await t.test('does not replace a good database with a non-SQLite object', async () => {
    const target = path.join(TMP, 'db-bad');
    fs.mkdirSync(target, { recursive: true });
    const dbFile = path.join(target, 'liam_memory.db');
    execFileSync(PYTHON, ['-c',
      'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.execute("insert into t values (1)"); c.commit()',
      dbFile]);
    const before = fs.readFileSync(dbFile);
    process.env.LIAM_DB = dbFile;
    objects.set('liam_memory.db', Buffer.from('<html>login</html>'));
    const result = await sync.restoreDb(target);
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /not a SQLite database/);
    assert.deepEqual(fs.readFileSync(dbFile), before);
  });

  await t.test('reports not configured without credentials', () => {
    // configured() reads module-level constants, so probe in a fresh process
    // with no Supabase variables instead of mutating the loaded module.
    const env = { ...process.env };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SECRET_KEY;
    const out = execFileSync(process.execPath, ['-e',
      'const s=require(process.argv[1]); process.stdout.write(String(s.configured()))',
      path.join(__dirname, '..', 'supabase_sync.js'),
    ], { encoding: 'utf8', env });
    assert.equal(out, 'false');
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(TMP, { recursive: true, force: true });
});
