'use strict';

// Exercises the bridge's local HTTP API against a stubbed WhatsApp fake.
// The bridge is copied to a temporary directory so no real session, cache, or
// credentials are touched.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const APP = fs.mkdtempSync(path.join(os.tmpdir(), 'liam-bridge-test-'));
const DATA = path.join(APP, 'data');
const OUTBOX = path.join(DATA, 'outbox');
fs.mkdirSync(OUTBOX, { recursive: true });

fs.copyFileSync(path.join(ROOT, 'whatsapp_bridge.js'), path.join(APP, 'whatsapp_bridge.js'));
fs.copyFileSync(path.join(ROOT, 'supabase_sync.js'), path.join(APP, 'supabase_sync.js'));
fs.copyFileSync(path.join(ROOT, 'liam_config.json'), path.join(APP, 'liam_config.json'));

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
  '    this.leftGroups = [];',
  '    this.messagesSent = 0;',
  '    global.__liamFakeSock = this;',
  '    // Baileys emits the first QR frame shortly after the socket is created.',
  '    setTimeout(() => { try { this.ev.emit("connection.update", { qr: "stub-qr" }); } catch (e) {} }, 0);',
  '  }',
  '  async requestPairingCode(phone) {',
  "    if (!/^\\d{7,15}$/.test(String(phone))) throw new Error('bad phone');",
  "    return 'ABCD1234';",
  '  }',
  '  async sendMessage(to, content, options) {',
  '    if (typeof content === "string") throw new TypeError("Cannot use \'in\' operator to search for \'text\' in " + content);',
  '    this.sent.push({ to, content, options });',
  "    return { key: { id: 'MSG-' + this.sent.length } };",
  '  }',
  '  async groupMetadata() { return { participants: [] }; }',
  '  async groupLeave(jid) { this.leftGroups.push(jid); }',
  '  end() {}',
  '}',
  'function makeWASocket(config) { return new FakeSocket(config); }',
  'async function useMultiFileAuthState(dir) {',
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

process.env.LIAM_DATA_DIR = DATA;
process.env.LIAM_PORT = '0';
process.env.LIAM_DM_ALLOWLIST = '2347000000009';
process.env.LIAM_DISABLE_AGENT = '1';

const bridge = require(path.join(APP, 'whatsapp_bridge.js'));
const CONFIG = require(path.join(APP, 'liam_config.json'));
const OWNER = CONFIG.owners[0];
const ADMIN = Object.keys(CONFIG.admins)[0];
const GROUP = '120363000000000000@g.us';
let fake = null;

after(() => {
  try { if (bridge.sync && bridge.sync.stopPeriodicBackup) bridge.sync.stopPeriodicBackup(); } catch (e) {}
  try { clearInterval(bridge.sweepTimer); } catch (e) {}
  try { if (bridge.stopAgent) bridge.stopAgent(); } catch (e) {}
  try { if (bridge.closeSocket) bridge.closeSocket('test finished'); } catch (e) {}
  try { bridge.server.close(); } catch (e) {}
  if (typeof bridge.server.closeAllConnections === 'function') {
    try { bridge.server.closeAllConnections(); } catch (e) {}
  }
  try { fs.rmSync(APP, { recursive: true, force: true }); } catch (e) {}
});

function request(port, options = {}) {
  const method = options.method || 'POST';
  const body = options.body === undefined ? '' :
    (typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
  const headers = { Host: `127.0.0.1:${port}`, Connection: 'close', ...(options.headers || {}) };
  if (method === 'POST') {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (!options.chunked) headers['Content-Length'] = Buffer.byteLength(body);
  }
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const req = http.request({
      host: '127.0.0.1', port, path: options.path || '/', method, headers, agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        finish(resolve, { status: res.statusCode, json, text: data });
      });
    });
    req.on('error', (error) => finish(reject, error));
    if (options.chunked) req.write(body);
    if (options.chunked) req.end();
    else req.end(body);
  });
}

test('bridge endpoint security and actions', async (t) => {
  if (!bridge.server.listening) await once(bridge.server, 'listening');
  await bridge.initializeWhatsApp('test');
  fake = bridge.getSock();
  // Let the stub deliver its first QR frame so pairing is allowed.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(fake, 'a fake Baileys socket should exist');
  const { port } = bridge.server.address();
  const token = fs.readFileSync(path.join(DATA, 'tool_token'), 'utf8').trim();
  const post = (body, extra = {}) => request(port, { body, token, ...extra });

  await t.test('accepts an authenticated message to an owner', async () => {
    const response = await post({ action: 'send', to: OWNER, text: 'hello', sender: OWNER });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const sent = fake.sent.at(-1);
    assert.equal(sent.to, `${OWNER}@s.whatsapp.net`);
    assert.deepEqual(sent.content, { text: 'hello' });
  });

  await t.test('rejects owner-only actions from non-owners', async () => {
    const response = await post({
      action: 'send', to: OWNER, text: 'hello', sender: '2348000000000',
    });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /only the owner/);
  });

  await t.test('rejects owner-only actions without sender context', async () => {
    const response = await post({ action: 'send', to: OWNER, text: 'hello' });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /missing sender/);
  });

  await t.test('rejects missing and wrong tokens', async () => {
    const missing = await request(port, {
      body: { action: 'send', to: OWNER, text: 'hello' },
    });
    assert.equal(missing.status, 401);
    const wrong = await request(port, {
      body: { action: 'send', to: OWNER, text: 'hello' },
      token: 'f'.repeat(64),
    });
    assert.equal(wrong.status, 401);
  });

  await t.test('rejects browser Origins (CSRF)', async () => {
    const response = await post(
      { action: 'send', to: OWNER, text: 'hello' },
      { headers: { Origin: 'https://evil.example' } },
    );
    assert.equal(response.status, 403);
  });

  await t.test('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const response = await post(
      { action: 'send', to: OWNER, text: 'hello' },
      { headers: { Host: `evil.example:${port}` } },
    );
    assert.equal(response.status, 403);
  });

  await t.test('requires application/json', async () => {
    const response = await post(
      { action: 'send', to: OWNER, text: 'hello' },
      { headers: { 'Content-Type': 'text/plain' } },
    );
    assert.equal(response.status, 415);
  });

  await t.test('rejects oversized declared bodies', async () => {
    const response = await post('x'.repeat(70 * 1024));
    assert.equal(response.status, 413);
  });

  await t.test('rejects oversized chunked bodies', async () => {
    const response = await post('x'.repeat(70 * 1024), { chunked: true });
    assert.equal(response.status, 413);
  });

  await t.test('rejects non-POST methods', async () => {
    const response = await request(port, { method: 'GET', token });
    assert.equal(response.status, 405);
  });

  await t.test('rejects malformed JSON', async () => {
    const response = await post('{');
    assert.equal(response.status, 400);
  });

  await t.test('rejects unknown actions', async () => {
    const response = await post({ action: 'wat' });
    assert.equal(response.status, 400);
  });

  await t.test('rejects recipients outside the allowlist', async () => {
    const response = await post({ action: 'send', to: '2347999999999', text: 'hi', sender: OWNER });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /allowlist/);
  });

  await t.test('accepts LIAM_DM_ALLOWLIST recipients', async () => {
    const response = await post({ action: 'send', to: '2347000000009', text: 'hi', sender: OWNER });
    assert.equal(response.status, 200);
    assert.equal(fake.sent.at(-1).to, '2347000000009@s.whatsapp.net');
  });

  await t.test('rejects invalid recipient formats', async () => {
    const response = await post({ action: 'send', to: 'not-a-number', text: 'hi', sender: OWNER });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /recipient/);
  });

  await t.test('normalizes group targets only when allowed', () => {
    assert.equal(bridge.isGroupJid(GROUP), true);
    assert.equal(bridge.isGroupJid('2347000000000@s.whatsapp.net'), false);
    assert.equal(bridge.normalizeRecipient(GROUP, true), GROUP);
    assert.throws(() => bridge.normalizeRecipient(GROUP), /recipient/);
    assert.equal(bridge.normalizeRecipient('2347000000009'), '2347000000009@s.whatsapp.net');
  });

  await t.test('sends an image and voice into a group', async () => {
    const image = path.join(OUTBOX, 'group.png');
    fs.writeFileSync(image, Buffer.from('PNGDATA'));
    const pic = await post({ action: 'image', to: GROUP, path: image, text: 'cap', sender: OWNER });
    assert.equal(pic.status, 200);
    assert.equal(fake.sent.at(-1).to, GROUP);

    const voice = path.join(OUTBOX, 'group.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const audio = await post({
      action: 'voice', to: GROUP, path: voice, mimetype: 'audio/wav', sender: OWNER,
    });
    assert.equal(audio.status, 200);
    assert.equal(fake.sent.at(-1).to, GROUP);
  });

  await t.test('still blocks a group target for non-owners', async () => {
    const image = path.join(OUTBOX, 'group.png');
    fs.writeFileSync(image, Buffer.from('PNGDATA'));
    const response = await post({ action: 'image', to: GROUP, path: image, sender: '2348999999999' });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /owner/);
  });

  await t.test('sends an image only from the outbox', async () => {
    const outside = path.join(APP, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    const blocked = await post({ action: 'image', to: OWNER, path: outside, sender: OWNER });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.msg, /outside the outbox/);

    const image = path.join(OUTBOX, 'test.png');
    fs.writeFileSync(image, Buffer.from('PNGDATA'));
    const allowed = await post({ action: 'image', to: OWNER, path: image, text: 'caption', sender: OWNER });
    assert.equal(allowed.status, 200);
    const sent = fake.sent.at(-1);
    assert.ok(Buffer.isBuffer(sent.content.image), 'image should be sent as bytes');
    assert.deepEqual(sent.content.image, fs.readFileSync(fs.realpathSync(image)));
    assert.equal(sent.content.caption, 'caption');
  });

  await t.test('rejects missing outbox files', async () => {
    const response = await post({
      action: 'image', to: OWNER, path: path.join(OUTBOX, 'missing.png'), sender: OWNER,
    });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /not found/);
  });

  await t.test('sends voice notes with a real mimetype', async () => {
    const voice = path.join(OUTBOX, 'voice.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const response = await post({
      action: 'voice', to: OWNER, path: voice, mimetype: 'audio/wav', sender: OWNER,
    });
    assert.equal(response.status, 200);
    const sent = fake.sent.at(-1);
    assert.equal(sent.content.ptt, true);
    assert.equal(sent.content.mimetype, 'audio/wav');
    assert.ok(Buffer.isBuffer(sent.content.audio));

    const inferred = await post({ action: 'voice', to: OWNER, path: voice, sender: OWNER });
    assert.equal(inferred.status, 200);
    assert.equal(fake.sent.at(-1).content.mimetype, 'audio/wav');
  });

  await t.test('rejects unsupported audio types', async () => {
    const voice = path.join(OUTBOX, 'voice2.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const response = await post({
      action: 'voice', to: OWNER, path: voice, mimetype: 'text/plain', sender: OWNER,
    });
    assert.equal(response.status, 400);
  });

  await t.test('leaves a group through the socket', async () => {
    const response = await post({ action: 'leave', jid: GROUP, sender: OWNER });
    assert.equal(response.status, 200);
    assert.equal(fake.leftGroups.includes(GROUP), true);
  });

  await t.test('validates permission changes', async () => {
    const allowed = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: true, sender: OWNER,
    });
    assert.equal(allowed.status, 200);
    const denied = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: false, sender: OWNER,
    });
    assert.equal(denied.status, 200);
    const badWho = await post({
      action: 'permission', jid: GROUP, who: 'x', allow: true, sender: OWNER,
    });
    assert.equal(badWho.status, 400);
    const badAllow = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: 'yes', sender: OWNER,
    });
    assert.equal(badAllow.status, 400);
  });

  await t.test('writes the stop flag atomically', async () => {
    const response = await post({ action: 'stop', sender: OWNER });
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(path.join(DATA, 'stop_flag'), 'utf8'), '1');
  });

  await t.test('exposes health, readiness and status separately', async () => {
    const health = await request(port, { method: 'GET', path: '/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'alive');
    const ready = await request(port, { method: 'GET', path: '/ready' });
    assert.equal(ready.status, 503);
    assert.equal(ready.json.whatsappReady, false);
    assert.equal(ready.json.ok, false);
    const status = await request(port, { method: 'GET', path: '/status' });
    assert.equal(status.status, 200);
    assert.equal(typeof status.json.status, 'string');
    assert.equal(typeof status.json.hasSessionData, 'boolean');
  });

  await t.test('protects pairing pages with the pairing token', async () => {
    const qrForbidden = await request(port, { method: 'GET', path: '/qr' });
    assert.equal(qrForbidden.status, 403);
    const qrOk = await request(port, { method: 'GET', path: `/qr?token=${bridge.PAIR_TOKEN}` });
    assert.equal(qrOk.status, 200);
    assert.match(qrOk.text, /phone code/);
    const pairForbidden = await request(port, { method: 'GET', path: '/pair' });
    assert.equal(pairForbidden.status, 403);
  });

  await t.test('generates an 8-character pairing code only on submit', async () => {
    const page = await request(port, {
      method: 'GET',
      path: `/pair?token=${bridge.PAIR_TOKEN}&phone=${OWNER}`,
    });
    assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /ABCD-1234/);
    const response = await request(port, {
      method: 'POST',
      path: `/pair?token=${bridge.PAIR_TOKEN}`,
      body: { phone: OWNER },
    });
    assert.equal(response.status, 200);
    assert.match(response.text, /ABCD-1234/);
  });

  await t.test('tool approvals require an exact one-time request id', async () => {
    bridge.pendingTools.clear();
    bridge.pendingPerms.clear();
    const member = '2348000000000';
    const p = await bridge.createToolApproval(
      'vps_exec', { command: 'id', timeout: 30, cwd: '' }, member,
      { chat: member, isGroup: false },
    );
    assert.match(p.id, /^t[0-9a-f]+$/);
    assert.equal(bridge.pendingTools.has(p.id), true);

    const bareYes = await bridge.handleApprovalCommand('yes', OWNER, `${OWNER}@s.whatsapp.net`, false);
    assert.equal(bareYes, true);
    assert.equal(bridge.pendingTools.has(p.id), true, 'bare yes must not approve a tool');

    const denied = await bridge.handleApprovalCommand(`no ${p.id}`, OWNER, `${OWNER}@s.whatsapp.net`, false);
    assert.equal(denied, true);
    assert.equal(bridge.pendingTools.has(p.id), false);

    const second = await bridge.createToolApproval(
      'vps_exec', { command: 'id', timeout: 30, cwd: '' }, member,
      { chat: member, isGroup: false },
    );
    const confirmed = await bridge.handleApprovalCommand(
      `yes ${second.id}`, OWNER, `${OWNER}@s.whatsapp.net`, false,
    );
    assert.equal(confirmed, true);
    assert.equal(bridge.pendingTools.has(second.id), false, 'approval is one-time');
    assert.match(String(fake.sent.at(-1).content.text), /vps_exec failed|InstaBox/);
  });

  await t.test('applies .allowdm semantics', async () => {
    const member = '2348111111111';
    assert.equal(bridge.dmAllowed(OWNER), true);
    assert.equal(bridge.dmAllowed(ADMIN), true);
    bridge.setDmOpen(false);
    assert.equal(bridge.dmAllowed(member), false);
    bridge.rememberKnownMember(member);
    assert.equal(bridge.dmAllowed(member), false, 'known members still need .allowdm');
    bridge.setDmOpen(true);
    assert.equal(bridge.dmAllowed(member), true);
    assert.equal(fs.readFileSync(path.join(DATA, 'dm_open'), 'utf8'), '1');
    bridge.setDmOpen(false);
    assert.equal(bridge.dmAllowed(member), false);
  });

  await t.test('members need owner approval for vps_exec', async () => {
    bridge.pendingTools.clear();
    const member = '2348000000000';
    const response = await post({
      action: 'vps_exec', command: 'id', timeout: 30, sender: member,
      chat: member, group: false,
    });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /owner approval required/);
    assert.equal(bridge.pendingTools.size, 1);
    bridge.pendingTools.clear();
  });

  await t.test('group permission prompts stay in the group, never a DM', async () => {
    bridge.pendingPerms.clear();
    const group = '2348000000000-123@g.us';
    const member = '2348999999999';
    fake.sent.length = 0;
    const p = await bridge.createPermissionRequest(group, member, 'hello there', { key: { id: 'TRIGGER' } });
    assert.ok(p, 'request should be created');
    const sent = fake.sent.at(-1);
    assert.equal(sent.to, group, 'prompt must go to the group');
    assert.match(sent.content.text, /Group permission needed/);
    const dm = fake.sent.some((m) => String(m.to).endsWith('@s.whatsapp.net'));
    assert.equal(dm, false, 'no owner DM may be sent for a group request');
    bridge.pendingPerms.clear();
  });

  await t.test('owners reach InstaBox directly but see a clear config error', async () => {
    const response = await post({ action: 'vps_exec', command: 'id', sender: OWNER });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /not configured/);
  });

  await t.test('rate-limits outbound messages', async () => {
    bridge.outboundLog.length = 0;
    for (let i = 0; i < 20; i += 1) {
      const response = await post({ action: 'send', to: OWNER, text: `burst ${i}`, sender: OWNER });
      assert.equal(response.status, 200);
    }
    const response = await post({ action: 'send', to: OWNER, text: 'too many', sender: OWNER });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /too many/);
  });
});
