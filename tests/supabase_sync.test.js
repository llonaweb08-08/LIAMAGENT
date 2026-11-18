'use strict';

// Exercises Supabase archive/snapshot handling against a local mock storage
// server. No real Supabase project, WhatsApp session, or network is used.
// Every subtest gets its own server, object map and module instance so the
// suite cannot depend on the order in which subtests run.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const PYTHON = process.env.LIAM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'liam-sync-test-'));
const MODULE_PATH = path.join(__dirname, '..', 'supabase_sync.js');
const ENV_KEYS = [
  'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_STORAGE_BUCKET',
  'LIAM_SUPABASE_TIMEOUT_MS', 'LIAM_UPLOAD_RETRY_MS', 'LIAM_MAX_UNCOMPRESSED_BYTES',
  'LIAM_MAX_STATE_BYTES', 'LIAM_DB',
];
let caseNumber = 0;

function testDir() {
  const dir = path.join(TMP, 'case-' + (++caseNumber));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function startServer(state) {
  const server = http.createServer((req, res) => {
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
      state.uploads.push(name);
      // let a pending injected status be delivered before injected drops, so
      // a "503 then transport error" sequence is deterministic.
      const pendingFailure = (state.fails.get(name) || {}).count > 0;
      const drops = pendingFailure ? 0 : (state.drops.get(name) || 0);
      if (drops > 0) {
        state.drops.set(name, drops - 1);
        // a transport error: fetch rejects without ever seeing a response.
        req.destroy();
        return;
      }
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('error', () => {});
      req.on('end', () => {
        const permanent = state.permanent.get(name);
        if (permanent) {
          res.writeHead(permanent);
          res.end('denied');
          return;
        }
        const failure = state.fails.get(name);
        if (failure && failure.count > 0) {
          failure.count -= 1;
          res.writeHead(503, { 'Content-Type': 'text/plain' });
          res.end('temporarily unavailable');
          return;
        }
        state.objects.set(name, Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }
    if (req.method === 'GET') {
      const body = state.objects.get(name);
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
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function withSync(t, options = {}) {
  const state = {
    objects: new Map(),
    fails: new Map(),
    permanent: new Map(),
    drops: new Map(),
    uploads: [],
  };
  const server = await startServer(state);
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  const env = Object.assign({
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`,
    SUPABASE_SECRET_KEY: 'test-secret',
    SUPABASE_STORAGE_BUCKET: 'liam-session',
    LIAM_SUPABASE_TIMEOUT_MS: '30000',
    LIAM_UPLOAD_RETRY_MS: '1',
  }, options.env || {});
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete require.cache[require.resolve(MODULE_PATH)];
  const sync = require(MODULE_PATH);
  t.after(async () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[require.resolve(MODULE_PATH)];
    await new Promise((resolve) => server.close(resolve));
  });
  return { sync, state };
}

function writeProfile(base) {
  const root = path.join(base, 'liam_session');
  const session = path.join(root, 'session');
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
  // a completed login: creds marked registered plus the link marker that boot
  // and the backup guard use to tell a linked profile from a half-finished one.
  fs.writeFileSync(path.join(session, 'creds.json'), JSON.stringify({ registered: true }));
  fs.writeFileSync(path.join(root, 'wa_linked.json'), JSON.stringify({ at: Date.now() }));
  return session;
}

// entries: [{ name, kind: file|symlink|fifo|char, data?, target? }]. python's
// tarfile can create traversal and special entries without host equivalents.
function writeTar(file, entries) {
  const script = [
    'import io, json, sys, tarfile',
    'path = sys.argv[1]',
    'entries = json.loads(sys.argv[2])',
    'with tarfile.open(path, "w:gz") as t:',
    '    for e in entries:',
    '        info = tarfile.TarInfo(e["name"])',
    '        kind = e.get("kind", "file")',
    '        if kind == "symlink":',
    '            info.type = tarfile.SYMTYPE',
    '            info.linkname = e.get("target", "")',
    '            t.addfile(info)',
    '        elif kind == "fifo":',
    '            info.type = tarfile.FIFOTYPE',
    '            t.addfile(info)',
    '        elif kind == "char":',
    '            info.type = tarfile.CHRTYPE',
    '            info.devmajor = 1',
    '            info.devminor = 3',
    '            t.addfile(info)',
    '        else:',
    '            data = (e.get("data") or "evil").encode()',
    '            info.size = len(data)',
    '            t.addfile(info, io.BytesIO(data))',
  ].join('\n');
  execFileSync(PYTHON, ['-c', script, file, JSON.stringify(entries)]);
}

function writeLinkArchive(file) {
  // a realistic old archive: useful files plus one chromium-style symlink.
  writeTar(file, [
    { name: 'liam_session/session/Default/Preferences', kind: 'file', data: '{}' },
    { name: 'liam_session/session/Default/IndexedDB/CURRENT', kind: 'file', data: 'indexeddb' },
    { name: 'liam_session/session/SingletonLock', kind: 'symlink', target: 'hostname-1234' },
  ]);
}

function sqliteValue(file) {
  const script = 'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("select x from t").fetchone()[0])';
  return execFileSync(PYTHON, ['-c', script, file], { encoding: 'utf8' }).trim();
}

function makeDb(file, row) {
  execFileSync(PYTHON, ['-c',
    'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.execute("insert into t values (?)", (int(sys.argv[2]),)); c.commit()',
    file, String(row)]);
}

function sparseFile(file, size) {
  const fd = fs.openSync(file, 'w');
  try { fs.ftruncateSync(fd, size); } finally { fs.closeSync(fd); }
}

test('supabase session and database persistence', async (t) => {
  await t.test('recognises unsafe archive entries', async (t) => {
    const { sync } = await withSync(t);
    assert.equal(sync.unsafeEntry('../evil'), true);
    assert.equal(sync.unsafeEntry('/etc/passwd'), true);
    assert.equal(sync.unsafeEntry('C:/Windows/win.ini'), true);
    assert.equal(sync.unsafeEntry('liam_session/../../evil'), true);
    assert.equal(sync.unsafeEntry('liam_session/session/Preferences'), false);
  });

  await t.test('accepts only whole integers from env vars', async (t) => {
    const { sync } = await withSync(t, { env: {
      LIAM_MAX_UNCOMPRESSED_BYTES: '5m',
      LIAM_CHECK_INT: '7',
    } });
    assert.equal(sync.envInt('LIAM_CHECK_INT', 99, 0, 100), 7);
    process.env.LIAM_CHECK_INT = '5m';
    assert.equal(sync.envInt('LIAM_CHECK_INT', 99, 0, 100), 99);
    process.env.LIAM_CHECK_INT = ' 12 ';
    assert.equal(sync.envInt('LIAM_CHECK_INT', 99, 0, 100), 12);
  });

  await t.test('detects the SQLite file header', async (t) => {
    const { sync } = await withSync(t);
    const dir = testDir();
    const db = path.join(dir, 'header.db');
    makeDb(db, 1);
    assert.equal(sync.looksLikeSqlite(db), true);
    const notDb = path.join(dir, 'not.db');
    fs.writeFileSync(notDb, '<html>not a db</html>');
    assert.equal(sync.looksLikeSqlite(notDb), false);
  });

  await t.test('removes stale Chrome lock files but not profile data', async (t) => {
    const { sync } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    const removed = sync.sanitizeChromeLocks(path.join(base, 'liam_session'));
    assert.ok(removed >= 2);
    assert.equal(fs.existsSync(path.join(base, 'liam_session/session/Default/Preferences')), true);
  });

  await t.test('archives the profile without caches or locks', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    const result = await sync.backupSession(base);
    assert.equal(result.ok, true);
    assert.ok(result.bytes > 0);

    const archive = path.join(base, 'session.tar.gz');
    fs.writeFileSync(archive, state.objects.get('session.tar.gz'));
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' });
    assert.match(listing, /Default\/IndexedDB\//);
    assert.match(listing, /Default\/Local Storage\//);
    assert.doesNotMatch(listing, /Default\/Cache\//);
    assert.doesNotMatch(listing, /Default\/Code Cache\//);
    assert.doesNotMatch(listing, /Default\/GPUCache\//);
    assert.doesNotMatch(listing, /lockfile|SingletonLock/);
  });

  await t.test('restores the archive into a new data directory', async (t) => {
    const { sync, state } = await withSync(t);
    const source = testDir();
    writeProfile(source);
    assert.equal((await sync.backupSession(source)).ok, true);
    const target = testDir();
    const result = await sync.restoreSession(target);
    assert.equal(result.restored, true);
    assert.ok(result.entries > 0);
    const session = path.join(target, 'liam_session', 'session');
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Preferences')), true);
    assert.equal(fs.existsSync(path.join(session, 'Default', 'IndexedDB')), true);
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Cache')), false);
    assert.equal(fs.existsSync(path.join(session, 'SingletonLock')), false);
    assert.ok(state.objects.has('session.tar.gz'));
  });

  await t.test('does not overwrite the cloud session before WhatsApp is ready', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    const keep = Buffer.from('keep this good copy');
    state.objects.set('session.tar.gz', keep);
    const result = await sync.backupNow(base, undefined, base, { session: false });
    assert.equal(result.session.skipped, true);
    assert.deepEqual(state.objects.get('session.tar.gz'), keep);
  });

  await t.test('treats a profile with the marker and registered creds as linked', async (t) => {
    const { sync } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    const session = path.join(base, 'liam_session');
    assert.equal(sync.sessionLooksLinked(session), true);
    fs.writeFileSync(path.join(session, 'session', 'creds.json'),
      JSON.stringify({ registered: false }));
    assert.equal(sync.sessionLooksLinked(session), false);
  });

  await t.test('never overwrites the cloud session with an unlinked profile', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    fs.rmSync(path.join(base, 'liam_session', 'wa_linked.json'));
    assert.equal(sync.sessionLooksLinked(path.join(base, 'liam_session')), false);
    const keep = Buffer.from('good cloud copy');
    state.objects.set('session.tar.gz', keep);
    const result = await sync.backupSession(base);
    assert.equal(result.skipped, true);
    assert.deepEqual(state.objects.get('session.tar.gz'), keep);
  });

  await t.test('skips an unchanged profile but notices same-size edits and sub-ms mtimes', async (t) => {
    const { sync } = await withSync(t);
    const base = testDir();
    writeProfile(base);
    const session = path.join(base, 'liam_session');
    const first = await sync.backupNow(base, undefined, base);
    assert.equal(first.session.ok, true);
    const before = sync.sessionSignature(session);
    assert.match(before, /Default\/Preferences:/);
    const second = await sync.backupNow(base, undefined, base);
    assert.equal(second.session.skipped, true);
    assert.equal(second.session.reason, 'session unchanged');

    // same size and the newest mtime is untouched: the old aggregate signature
    // could not see this change.
    const file = path.join(session, 'session', 'Default', 'Preferences');
    fs.writeFileSync(file, '[]');
    const older = new Date(1700000000000.25);
    fs.utimesSync(file, older, older);
    const after = sync.sessionSignature(session);
    assert.notEqual(after, before);
    const precise = String(fs.statSync(file).mtimeMs);
    if (precise.includes('.')) assert.ok(after.includes(precise), 'full mtime precision');
    assert.equal((await sync.backupNow(base, undefined, base)).session.ok, true);
  });

  await t.test('restores normal files from an archive that also contains a link', async (t) => {
    const { sync, state } = await withSync(t);
    const dir = testDir();
    const archive = path.join(dir, 'links.tar.gz');
    writeLinkArchive(archive);
    const info = await sync.validateArchive(archive, 'liam_session');
    assert.equal(info.links, 1);
    assert.ok(info.entries >= 3);

    state.objects.set('session.tar.gz', fs.readFileSync(archive));
    const result = await sync.restoreSession(dir);
    assert.equal(result.restored, true);
    assert.equal(result.skippedLinks, 1);
    const session = path.join(dir, 'liam_session', 'session');
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Preferences')), true);
    assert.equal(fs.existsSync(path.join(session, 'Default', 'IndexedDB', 'CURRENT')), true);
    assert.equal(fs.existsSync(path.join(session, 'SingletonLock')), false);
  });

  await t.test('counts a valid-path symlink as special and refuses to back it up', async (t) => {
    const { sync, state } = await withSync(t);
    const dir = testDir();
    const archive = path.join(dir, 'valid-link.tar.gz');
    writeTar(archive, [
      { name: 'liam_session/session/Default/Preferences', kind: 'file', data: '{}' },
      // no traversal: this link must be caught by the type check, not the path check.
      { name: 'liam_session/session/local-link', kind: 'symlink', target: 'Preferences' },
    ]);
    const info = await sync.validateArchive(archive, 'liam_session');
    assert.equal(info.links, 1);
    assert.equal(info.entries, 2);

    // direct backup refusal: a dangling symlink survives --dereference, so the
    // archive built by backupSession must be rejected before upload.
    const base = testDir();
    writeProfile(base);
    try {
      fs.symlinkSync('does-not-exist', path.join(base, 'liam_session', 'session', 'dangling-link'));
    } catch (e) {
      return; // symlink creation is restricted on some hosts
    }
    const keep = Buffer.from('good cloud copy');
    state.objects.set('session.tar.gz', keep);
    const result = await sync.backupSession(base);
    assert.equal(result.ok, false);
    assert.match(String(result.error || result.reason || ''), /link entries/);
    assert.deepEqual(state.objects.get('session.tar.gz'), keep);
  });

  await t.test('rejects an archive with traversal entries', async (t) => {
    const { sync, state } = await withSync(t);
    const dir = testDir();
    const archive = path.join(dir, 'unsafe.tar.gz');
    writeTar(archive, [{ name: '../evil', kind: 'file' }]);
    state.objects.set('session.tar.gz', fs.readFileSync(archive));
    const result = await sync.restoreSession(dir);
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /unsafe archive entry/);
    assert.equal(fs.existsSync(path.join(dir, 'evil')), false);
  });

  await t.test('routes fifos and devices to the safe extractor', async (t) => {
    const { sync, state } = await withSync(t);
    const dir = testDir();
    const archive = path.join(dir, 'special.tar.gz');
    writeTar(archive, [
      { name: 'liam_session/session/Default/Preferences', kind: 'file', data: '{}' },
      { name: 'liam_session/session/pipe', kind: 'fifo' },
      { name: 'liam_session/session/dev', kind: 'char' },
    ]);
    const info = await sync.validateArchive(archive, 'liam_session');
    assert.equal(info.links, 2);
    state.objects.set('session.tar.gz', fs.readFileSync(archive));
    const result = await sync.restoreSession(dir);
    assert.equal(result.restored, true);
    assert.equal(result.skippedLinks, 2);
    const session = path.join(dir, 'liam_session', 'session');
    assert.equal(fs.existsSync(path.join(session, 'Default', 'Preferences')), true);
    assert.equal(fs.existsSync(path.join(session, 'pipe')), false);
    assert.equal(fs.existsSync(path.join(session, 'dev')), false);
  });

  await t.test('rejects an archive whose uncompressed members exceed the cap', async (t) => {
    const { sync, state } = await withSync(t, { env: { LIAM_MAX_UNCOMPRESSED_BYTES: '1024' } });
    const dir = testDir();
    const archive = path.join(dir, 'huge.tar.gz');
    writeTar(archive, [{ name: 'liam_session/session/big', kind: 'file', data: 'x'.repeat(4096) }]);
    state.objects.set('session.tar.gz', fs.readFileSync(archive));
    const result = await sync.restoreSession(path.join(dir, 'restore'));
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /expands beyond/);
    assert.equal(fs.existsSync(path.join(dir, 'restore', 'liam_session')), false);
  });

  await t.test('creates a missing parent for a nested custom sessionDir', async (t) => {
    const { sync } = await withSync(t);
    const source = testDir();
    writeProfile(source);
    assert.equal((await sync.backupSession(source)).ok, true);
    const target = path.join(testDir(), 'nested', 'deep', 'liam_session');
    const result = await sync.restoreSession(testDir(), target);
    assert.equal(result.restored, true);
    assert.equal(fs.existsSync(path.join(target, 'session', 'Default', 'Preferences')), true);
  });

  await t.test('recovers a session left aside by an interrupted swap', async (t) => {
    const dir = testDir();
    const target = path.join(dir, 'liam_session');
    fs.mkdirSync(path.join(target, 'session'), { recursive: true });
    fs.writeFileSync(path.join(target, 'marker'), 'old');
    fs.renameSync(target, target + '.old.1000');
    const { sync, state } = await withSync(t);
    state.objects.set('session.tar.gz', Buffer.from('not a gzip archive'));
    const result = await sync.restoreSession(dir);
    assert.equal(result.restored, false);
    assert.equal(fs.readFileSync(path.join(target, 'marker'), 'utf8'), 'old');
  });

  await t.test('backs up a WAL-safe database and keeps a rollback copy on restore', async (t) => {
    const source = testDir();
    const dbFile = path.join(source, 'liam_memory.db');
    makeDb(dbFile, 1);
    const { sync, state } = await withSync(t, { env: { LIAM_DB: dbFile } });
    const backup = await sync.backupDb(source);
    assert.equal(backup.ok, true);
    assert.ok(state.objects.get('liam_memory.db').length > 0);

    const target = testDir();
    const restored = path.join(target, 'liam_memory.db');
    makeDb(restored, 1); // the local copy that must survive as a rollback
    const other = path.join(target, 'other.db');
    makeDb(other, 2);
    state.objects.set('liam_memory.db', fs.readFileSync(other));
    // defaultDbFile() reads LIAM_DB at call time; point the restore at target.
    process.env.LIAM_DB = restored;
    const result = await sync.restoreDb(target);
    assert.equal(result.restored, true);
    assert.equal(sqliteValue(restored), '2');
    const oldCopies = fs.readdirSync(target).filter((name) => name.startsWith('liam_memory.db.old.'));
    assert.equal(oldCopies.length, 1);
    assert.equal(sqliteValue(path.join(target, oldCopies[0])), '1');
  });

  await t.test('does not replace a good database with a non-SQLite object', async (t) => {
    const dir = testDir();
    const dbFile = path.join(dir, 'liam_memory.db');
    makeDb(dbFile, 1);
    const { sync, state } = await withSync(t, { env: { LIAM_DB: dbFile } });
    const before = fs.readFileSync(dbFile);
    state.objects.set('liam_memory.db', Buffer.from('<html>login</html>'));
    const result = await sync.restoreDb(dir);
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /not a SQLite database/);
    assert.deepEqual(fs.readFileSync(dbFile), before);
  });

  await t.test('rejects a truncated cloud database despite its SQLite header', async (t) => {
    const dir = testDir();
    const dbFile = path.join(dir, 'liam_memory.db');
    makeDb(dbFile, 1);
    const { sync, state } = await withSync(t, { env: { LIAM_DB: dbFile } });
    const before = fs.readFileSync(dbFile);
    state.objects.set('liam_memory.db', before.subarray(0, 64));
    const result = await sync.restoreDb(dir);
    assert.equal(result.restored, false);
    assert.match(String(result.error || ''), /integrity/);
    assert.deepEqual(fs.readFileSync(dbFile), before);
  });

  await t.test('round-trips a small JSON state object', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    const value = { v: 1, savedAt: 123, temp: { 'g@g.us': { '2348000000000': 456 } } };
    const up = await sync.uploadState(base, 'bridge_state.json', value);
    assert.equal(up.ok, true);
    const down = await sync.downloadState('bridge_state.json');
    assert.equal(down.restored, true);
    assert.deepEqual(down.value, value);
    assert.ok(state.objects.has('bridge_state.json'));
    assert.equal(fs.readdirSync(base).some((name) => name.endsWith('.upload.tmp')), false);
  });

  await t.test('uses a unique temp name for each state upload', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    const sentinel = path.join(base, 'bridge_state.json.upload.tmp');
    fs.writeFileSync(sentinel, 'keep');
    const up = await sync.uploadState(base, 'bridge_state.json', { a: 1 });
    assert.equal(up.ok, true);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
    assert.deepEqual(JSON.parse(state.objects.get('bridge_state.json').toString()), { a: 1 });
  });

  await t.test('enforces byte limits and reports malformed JSON state', async (t) => {
    const { sync, state } = await withSync(t, { env: { LIAM_MAX_STATE_BYTES: '5' } });
    const base = testDir();
    // "😀" is 6 UTF-8 bytes but only 4 UTF-16 units.
    const overUpload = await sync.uploadState(base, 'emoji.json', '😀');
    assert.equal(overUpload.ok, false);
    assert.match(String(overUpload.reason), /too large/);
    state.objects.set('emoji.json', Buffer.from('"😀"', 'utf8'));
    const overDownload = await sync.downloadState('emoji.json');
    assert.equal(overDownload.restored, false);
    assert.match(String(overDownload.reason), /too large/);

    state.objects.set('bad.json', Buffer.from('{'));
    const badDownload = await sync.downloadState('bad.json');
    assert.equal(badDownload.restored, false);
    assert.ok(badDownload.error);
    const badUpload = await sync.uploadState(base, 'bad.json', 1n);
    assert.equal(badUpload.ok, false);
    assert.ok(badUpload.error);
  });

  await t.test('retries a transient upload once and reports the newest error', async (t) => {
    const { sync, state } = await withSync(t);
    const base = testDir();
    state.fails.set('retry.json', { count: 1 });
    const up = await sync.uploadState(base, 'retry.json', { a: 1 });
    assert.equal(up.ok, true, 'the single retry should succeed');
    assert.equal(state.uploads.filter((name) => name === 'retry.json').length, 2);

    // first attempt: 503. second attempt: stream and buffered fallback both
    // fail, so the thrown error must replace the earlier status.
    state.fails.set('throw.json', { count: 1 });
    state.drops.set('throw.json', 2);
    const failed = await sync.uploadState(base, 'throw.json', { a: 1 });
    assert.equal(failed.ok, false);
    assert.match(String(failed.reason || failed.error), /fetch failed|aborted|socket|terminated/i);
    assert.doesNotMatch(String(failed.reason || failed.error), /status 503/);
    assert.equal(state.uploads.filter((name) => name === 'throw.json').length, 3);
  });

  await t.test('never buffers a 300 MB session or a 200 MB db, and does not retry permanent errors', async (t) => {
    const { sync, state } = await withSync(t);
    const dir = testDir();
    const sessionFile = path.join(dir, 'session.tar.gz');
    const dbFile = path.join(dir, 'liam_memory.db');
    sparseFile(sessionFile, 300 * 1024 * 1024);
    sparseFile(dbFile, 200 * 1024 * 1024);
    state.drops.set('session.tar.gz', 2);
    state.drops.set('liam_memory.db', 2);

    const originalRead = fs.readFileSync;
    const originalStream = fs.createReadStream;
    const reads = [];
    let destroyed = 0;
    fs.readFileSync = function (...args) {
      reads.push(String(args[0]));
      return originalRead.apply(this, args);
    };
    fs.createReadStream = function (...args) {
      const stream = originalStream.apply(this, args);
      const originalDestroy = stream.destroy.bind(stream);
      stream.destroy = (...rest) => { destroyed += 1; return originalDestroy(...rest); };
      return stream;
    };
    try {
      const sessionResult = await sync.uploadPath('session.tar.gz', sessionFile, 'application/gzip');
      const dbResult = await sync.uploadPath('liam_memory.db', dbFile, 'application/octet-stream');
      assert.equal(sessionResult.ok, false);
      assert.equal(dbResult.ok, false);
      assert.equal(reads.includes(sessionFile), false, 'session archives must never be buffered');
      assert.equal(reads.includes(dbFile), false, 'a 200 MB db must not be buffered');
      assert.ok(destroyed >= 4, 'failed read streams are destroyed');
      assert.equal(state.uploads.filter((n) => n === 'session.tar.gz').length, 2);
      assert.equal(state.uploads.filter((n) => n === 'liam_memory.db').length, 2);

      const small = path.join(dir, 'small.json');
      fs.writeFileSync(small, '{}');
      state.permanent.set('small.json', 401);
      const permanent = await sync.uploadPath('small.json', small, 'application/json');
      assert.equal(permanent.ok, false);
      assert.match(String(permanent.reason), /status 401/);
      assert.equal(state.uploads.filter((n) => n === 'small.json').length, 1);
    } finally {
      fs.readFileSync = originalRead;
      fs.createReadStream = originalStream;
    }
  });

  await t.test('reports not configured without credentials', async (t) => {
    // configured() reads module-level constants, so probe in a fresh process
    // with no Supabase variables instead of mutating the loaded module.
    const env = { ...process.env };
    delete env.SUPABASE_URL;
    delete env.SUPABASE_SECRET_KEY;
    const out = execFileSync(process.execPath, ['-e',
      'const s=require(process.argv[1]); process.stdout.write(String(s.configured()))',
      MODULE_PATH,
    ], { encoding: 'utf8', env });
    assert.equal(out, 'false');
  });
});

after(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
});
