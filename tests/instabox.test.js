'use strict';

// Verifies that a configured INSTABOX_MACHINE_ID which belongs to a different
// InstaBox account is ignored, so swapping in a key from a new account heals
// itself instead of failing every browser/screenshot call. A local mock
// InstaBox API is used; no real network or account is touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
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

const calls = [];
let server;
let bridge;

test('a stale InstaBox machine id is ignored and the account machine is used', async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    calls.push(req.method + ' ' + url.pathname);
    req.resume();
    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && url.pathname === '/v1/machines') {
      return send(200, { machines: [{ id: 'account-machine' }] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/machines/account-machine') {
      return send(200, { id: 'account-machine', state: 'running' });
    }
    if (req.method === 'POST' && url.pathname === '/v1/machines/account-machine/exec') {
      return send(200, { exitCode: 0, stdout: 'hello from the VM', stderr: '' });
    }
    return send(404, { error: { code: 'not_found', message: 'no such route' } });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  process.env.LIAM_DATA_DIR = DATA;
  process.env.LIAM_PORT = '0';
  process.env.LIAM_DISABLE_AGENT = '1';
  process.env.INSTABOX_API_KEY = 'test-key';
  process.env.INSTABOX_API_URL = `http://127.0.0.1:${port}`;
  process.env.INSTABOX_MACHINE_ID = 'stale-machine';

  bridge = require(path.join(APP, 'whatsapp_bridge.js'));

  const out = await bridge.instaboxExec('echo hi');
  assert.match(out, /exit=0/);
  assert.match(out, /hello from the VM/);
  assert.ok(calls.includes('GET /v1/machines'), 'the account machine list is consulted');
  assert.ok(calls.includes('POST /v1/machines/account-machine/exec'), 'the exec targets the account machine');
  assert.ok(!calls.some((c) => c.includes('stale-machine')), 'the stale machine is never used');

  // The account is validated only once; later calls reuse the resolved machine.
  const before = calls.filter((c) => c === 'GET /v1/machines').length;
  await bridge.instaboxExec('echo again');
  const after = calls.filter((c) => c === 'GET /v1/machines').length;
  assert.equal(after, before, 'the account is listed only once per process');
});

after(() => {
  try { if (bridge && bridge.sync && bridge.sync.stopPeriodicBackup) bridge.sync.stopPeriodicBackup(); } catch (e) {}
  try { if (bridge && bridge.sweepTimer) clearInterval(bridge.sweepTimer); } catch (e) {}
  try { if (bridge && bridge.stopAgent) bridge.stopAgent(); } catch (e) {}
  try { if (bridge && bridge.closeSocket) bridge.closeSocket('test finished'); } catch (e) {}
  try { if (bridge && bridge.server) bridge.server.close(); } catch (e) {}
  try { if (server) server.close(); } catch (e) {}
  try { fs.rmSync(APP, { recursive: true, force: true }); } catch (e) {}
});
