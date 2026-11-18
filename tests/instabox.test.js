'use strict';

// Verifies InstaBox machine discovery and exec against a local mock API. The
// cases cover a stale configured id, an empty machine list (create once), a
// failing list (with and without a configured id), a non-200 exec response,
// and a command that exits non-zero. No real network or account is touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after, before } = require('node:test');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'liam-instabox-test-'));
const DATA = path.join(APP, 'data');
fs.mkdirSync(DATA, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'whatsapp_bridge.js'), path.join(APP, 'whatsapp_bridge.js'));
fs.copyFileSync(path.join(ROOT, 'supabase_sync.js'), path.join(APP, 'supabase_sync.js'));
fs.copyFileSync(path.join(ROOT, 'liam_config.json'), path.join(APP, 'liam_config.json'));

// Minimal Baileys stub so requiring the bridge never touches a real session.
const baileysStubDir = path.join(APP, 'node_modules', '@whiskeysockets', 'baileys');
fs.mkdirSync(baileysStubDir, { recursive: true });
fs.writeFileSync(path.join(baileysStubDir, 'index.js'), [
  "'use strict';",
  "const { EventEmitter } = require('node:events');",
  'class FakeSocket {',
  '  constructor(config) {',
  '    this.config = config;',
  '    this.ev = new EventEmitter();',
  '    this.authState = { creds: { registered: false } };',
  '    this.user = { id: "2340000000000@s.whatsapp.net", lid: "100000000000001@lid" };',
  '    this.sent = [];',
  '  }',
  '  async requestPairingCode() { return "ABCD1234"; }',
  '  async sendMessage(to, content, options) { this.sent.push({ to, content, options }); return { key: { id: "MSG" } }; }',
  '  async groupMetadata() { return { participants: [] }; }',
  '  async groupLeave() {}',
  '  async readMessages() {}',
  '  async sendPresenceUpdate() {}',
  '  end() {}',
  '}',
  'function makeWASocket(config) { return new FakeSocket(config); }',
  'async function useMultiFileAuthState() {',
  '  return { state: { creds: { registered: false } }, saveCreds: async () => {} };',
  '}',
  'async function fetchLatestBaileysVersion() { return { version: [2, 3000, 0], isLatest: true }; }',
  'const DisconnectReason = { loggedOut: 401, restartRequired: 515, connectionClosed: 428 };',
  'const Browsers = { ubuntu: () => ["Ubuntu", "Chrome", "22.04.4"] };',
  'function isJidGroup(jid) { return String(jid || "").endsWith("@g.us"); }',
  'function getContentType(message) {',
  '  if (!message || typeof message !== "object") return null;',
  '  return Object.keys(message).find((k) => k !== "messageContextInfo") || null;',
  '}',
  'function normalizeMessageContent(message) { return message; }',
  'module.exports = {',
  '  __esModule: true, default: makeWASocket,',
  '  useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, Browsers,',
  '  isJidGroup, getContentType, normalizeMessageContent,',
  '};',
].join('\n'));

const BRIDGE = path.join(APP, 'whatsapp_bridge.js');
const calls = [];
let server;
let activeBridge = null;
let scenario;

process.env.LIAM_DATA_DIR = DATA;
process.env.LIAM_PORT = '0';
process.env.LIAM_DISABLE_AGENT = '1';
process.env.INSTABOX_API_KEY = 'test-key';

function defaultScenario() {
  return {
    listStatus: 200,
    listBody: { machines: [{ id: 'account-machine' }] },
    createStatus: 200,
    createBody: { id: 'op-1', machineId: 'created-machine' },
    opStatus: 200,
    opBody: { state: 'succeeded', machine: { id: 'created-machine' } },
    infoStatus: 200,
    infoBody: { id: 'account-machine', state: 'running' },
    execStatus: 200,
    execBody: { exitCode: 0, stdout: 'hello from the VM', stderr: '' },
  };
}

const send = (res, status, obj) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(req.method + ' ' + url.pathname);
    req.resume();
    const p = url.pathname;
    if (req.method === 'GET' && p === '/v1/machines') return send(res, scenario.listStatus, scenario.listBody);
    if (req.method === 'POST' && p === '/v1/machines') return send(res, scenario.createStatus, scenario.createBody);
    if (req.method === 'GET' && p.startsWith('/v1/operations/')) return send(res, scenario.opStatus, scenario.opBody);
    if (req.method === 'POST' && /\/exec$/.test(p)) return send(res, scenario.execStatus, scenario.execBody);
    if (req.method === 'GET' && /^\/v1\/machines\/[^/]+$/.test(p)) return send(res, scenario.infoStatus, scenario.infoBody);
    return send(res, 404, { error: { code: 'not_found', message: 'no such route' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  process.env.INSTABOX_API_URL = `http://127.0.0.1:${server.address().port}`;
});

async function unloadBridge() {
  const bridge = activeBridge;
  activeBridge = null;
  if (!bridge) return;
  try { if (bridge.sync && bridge.sync.stopPeriodicBackup) bridge.sync.stopPeriodicBackup(); } catch (e) {}
  try { if (bridge.sweepTimer) clearInterval(bridge.sweepTimer); } catch (e) {}
  try { if (bridge.stopAgent) bridge.stopAgent(); } catch (e) {}
  try { if (bridge.closeSocket) bridge.closeSocket('test finished'); } catch (e) {}
  try {
    if (bridge.server) {
      if (bridge.server.closeAllConnections) bridge.server.closeAllConnections();
      if (bridge.server.listening) {
        const closed = once(bridge.server, 'close');
        bridge.server.close();
        await closed;
      }
    }
  } catch (e) {}
}

async function loadBridge(machineId) {
  await unloadBridge();
  process.env.INSTABOX_MACHINE_ID = machineId;
  calls.length = 0;
  delete require.cache[require.resolve(BRIDGE)];
  activeBridge = require(BRIDGE);
  return activeBridge;
}

test('a stale InstaBox machine id is ignored and the account machine is used', async () => {
  scenario = defaultScenario();
  const bridge = await loadBridge('stale-machine');

  const out = await bridge.instaboxExec('echo hi');
  assert.match(out, /exit=0/);
  assert.match(out, /hello from the VM/);
  assert.ok(calls.includes('GET /v1/machines'), 'the account machine list is consulted');
  assert.ok(calls.includes('POST /v1/machines/account-machine/exec'), 'the exec targets the account machine');
  assert.ok(!calls.some((c) => c.includes('stale-machine')), 'the stale machine is never used');

  // The account is validated only once; later calls reuse the resolved machine.
  const listCountBefore = calls.filter((c) => c === 'GET /v1/machines').length;
  await bridge.instaboxExec('echo again');
  const listCountAfter = calls.filter((c) => c === 'GET /v1/machines').length;
  assert.equal(listCountAfter, listCountBefore, 'the account is listed only once per process');
});

test('an empty machine list creates one machine and reuses it', async () => {
  scenario = defaultScenario();
  scenario.listBody = { machines: [] };
  const bridge = await loadBridge('');

  const out = await bridge.instaboxExec('echo hi');
  assert.match(out, /exit=0/);
  assert.match(out, /hello from the VM/);
  assert.equal(calls.filter((c) => c === 'POST /v1/machines').length, 1, 'one machine is created');
  assert.ok(calls.includes('GET /v1/operations/op-1'), 'the create operation is awaited');
  assert.ok(calls.includes('POST /v1/machines/created-machine/exec'), 'exec targets the created machine');

  await bridge.instaboxExec('echo again');
  assert.equal(calls.filter((c) => c === 'POST /v1/machines').length, 1, 'the machine is created only once');
});

test('a failing machine list falls back to a configured id', async () => {
  scenario = defaultScenario();
  scenario.listStatus = 500;
  scenario.listBody = { error: { code: 'server_error', message: 'boom' } };
  const bridge = await loadBridge('configured-machine');

  const out = await bridge.instaboxExec('echo hi');
  assert.match(out, /exit=0/);
  assert.ok(calls.includes('POST /v1/machines/configured-machine/exec'), 'the configured id is trusted');
  assert.ok(!calls.includes('POST /v1/machines'), 'no machine is created when a configured id exists');
});

test('a failing machine list with no configured id surfaces the error', async () => {
  scenario = defaultScenario();
  scenario.listStatus = 500;
  scenario.listBody = { error: { code: 'server_error', message: 'boom' } };
  const bridge = await loadBridge('');

  await assert.rejects(() => bridge.instaboxExec('echo hi'), /InstaBox HTTP 500/);
  assert.ok(!calls.some((c) => c.endsWith('/exec')), 'exec is never attempted without a machine');
});

test('a non-200 exec response rejects with the InstaBox status', async () => {
  scenario = defaultScenario();
  scenario.execStatus = 500;
  scenario.execBody = { error: { code: 'exec_failed', message: 'nope' } };
  const bridge = await loadBridge('account-machine');

  await assert.rejects(() => bridge.instaboxExec('echo hi'), /InstaBox HTTP 500/);
});

test('a non-zero exit code and a timeout are reported in the exec output', async () => {
  scenario = defaultScenario();
  scenario.execBody = { exitCode: 7, stdout: '', stderr: 'bad command' };
  const bridge = await loadBridge('account-machine');

  const out = await bridge.instaboxExec('false');
  assert.match(out, /exit=7/);
  assert.match(out, /bad command/);

  scenario.execBody = { exitCode: 1, stdout: '', stderr: '', timedOut: true };
  const timedOut = await bridge.instaboxExec('sleep 999');
  assert.match(timedOut, /command timed out/);
});

after(async () => {
  await unloadBridge();
  try { if (server) { if (server.closeAllConnections) server.closeAllConnections(); server.close(); } } catch (e) {}
  try { fs.rmSync(APP, { recursive: true, force: true }); } catch (e) {}
});
