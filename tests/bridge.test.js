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
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

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
  '  async readMessages(keys) { this.read = (this.read || []).concat(keys || []); }',
  '  async sendPresenceUpdate(type, jid) { (this.presence = this.presence || []).push({ type, jid }); }',
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
  if (options.cookie) headers.Cookie = options.cookie;

  const maxRedirects = options.maxRedirects == null ? 0 : options.maxRedirects;
  const doReq = (reqPath, redirectsLeft, cookieJar) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const h = { ...headers };
    if (cookieJar) h.Cookie = cookieJar;
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath || '/', method, headers: h, agent: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) {}
        if (redirectsLeft > 0 && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const setCookie = res.headers['set-cookie'];
          let nextCookie = cookieJar;
          if (Array.isArray(setCookie) && setCookie.length) {
            // keep simple cookie jar (name=value) for follow-up
            const pairs = setCookie.map((c) => String(c).split(';')[0]).filter(Boolean);
            nextCookie = pairs.join('; ');
          }
          const loc = res.headers.location.startsWith('http')
            ? new URL(res.headers.location).pathname + new URL(res.headers.location).search
            : res.headers.location;
          // follow redirects as GET
          const followMethod = options.followMethod || 'GET';
          const follow = { ...options, method: followMethod, path: loc, maxRedirects: 0, cookie: nextCookie };
          // For follow, no body
          const fh = { Host: `127.0.0.1:${port}`, Connection: 'close' };
          if (nextCookie) fh.Cookie = nextCookie;
          const fr = http.request({ host: '127.0.0.1', port, path: loc, method: followMethod, headers: fh, agent: false }, (r2) => {
            let d2 = '';
            r2.setEncoding('utf8');
            r2.on('data', (c) => { d2 += c; });
            r2.on('end', () => {
              let j2 = null; try { j2 = JSON.parse(d2); } catch (e) {}
              finish(resolve, { status: r2.statusCode, json: j2, text: d2, headers: r2.headers, redirect: { status: res.statusCode, location: res.headers.location, headers: res.headers } });
            });
          });
          fr.on('error', (error) => finish(reject, error));
          fr.end();
          return;
        }
        finish(resolve, { status: res.statusCode, json, text: data, headers: res.headers });
      });
    });
    req.on('error', (error) => finish(reject, error));
    if (options.chunked) req.write(body);
    if (options.chunked) req.end();
    else req.end(body);
  });
  return doReq(options.path || '/', maxRedirects, options.cookie || null);
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
  // BR-17: owner-scoped actions need the separate owner token that the bridge
  // gives only to its own agent process. The normal loop token still works for
  // everyone else and for approval requests.
  const ownerPhones = new Set((Array.isArray(CONFIG.owners) ? CONFIG.owners : [])
    .map((p) => String(p).split('@')[0]));
  const post = (body, extra = {}) => {
    const sender = body && typeof body === 'object' ? String(body.sender || '').split('@')[0] : '';
    return request(port, { body, token: ownerPhones.has(sender) ? bridge.OWNER_TOKEN : token, ...extra });
  };

  await t.test('accepts an authenticated message to an owner', async () => {
    const response = await post({ action: 'send', to: OWNER, text: 'hello', sender: OWNER });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const sent = fake.sent.at(-1);
    assert.equal(sent.to, `${OWNER}@s.whatsapp.net`);
    assert.deepEqual(sent.content, { text: 'hello' });
  });

  await t.test('delivers a progress update to the chat where the task was given', async () => {
    fake.sent.length = 0;
    await bridge.deliverProgress('I am on the signup page', { to: GROUP, isGroup: true });
    assert.equal(fake.sent.at(-1).to, GROUP);
    assert.equal(fake.sent.at(-1).content.text, 'I am on the signup page');

    fake.sent.length = 0;
    const dm = `${OWNER}@s.whatsapp.net`;
    await bridge.deliverProgress('done, what next?', { to: dm, isGroup: false });
    assert.equal(fake.sent.at(-1).to, dm);
    assert.equal(fake.sent.at(-1).content.text, 'done, what next?');
  });

  await t.test('a blank progress update sends nothing', async () => {
    fake.sent.length = 0;
    await bridge.deliverProgress('   ', { to: GROUP, isGroup: true });
    await bridge.deliverProgress('hi', null);
    assert.equal(fake.sent.length, 0);
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

  await t.test('lets a member voice-note only their own chat', async () => {
    const voice = path.join(OUTBOX, 'member.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const allowed = await post({
      action: 'voice', to: GROUP, chat: GROUP, path: voice, mimetype: 'audio/wav',
      sender: '2348000000000',
    });
    assert.equal(allowed.status, 200);
    assert.equal(fake.sent.at(-1).to, GROUP);
    assert.equal(fake.sent.at(-1).content.ptt, true);

    const elsewhere = await post({
      action: 'voice', to: `${OWNER}@s.whatsapp.net`, chat: GROUP, path: voice,
      mimetype: 'audio/wav', sender: '2348000000000',
    });
    assert.equal(elsewhere.status, 400);
    assert.match(elsewhere.json.msg, /only send a voice note to this chat/);
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

  await t.test('hard-stops the agent and can power it back on from the tool endpoint', async () => {
    const hardStop = await post({ action: 'stop_agent', sender: OWNER });
    assert.equal(hardStop.status, 200);
    assert.equal(hardStop.json.ok, true);
    const start = await post({ action: 'start_agent', sender: OWNER });
    assert.equal(start.status, 200);
    assert.equal(start.json.ok, true);
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

  await t.test('exposes a server-down fallback and a gated keep-alive', async () => {
    assert.equal(typeof bridge.SERVER_DOWN_TEXT, 'string');
    assert.match(bridge.SERVER_DOWN_TEXT, /server is down/i);
    assert.equal(typeof bridge.startKeepAlive, 'function');
    // No public URL in the test process, so the keep-alive must be a safe no-op.
    bridge.startKeepAlive();
    bridge.startKeepAlive();
  });

  await t.test('signals read + typing while answering', async () => {
    fake.presence = [];
    fake.read = [];
    bridge.markReadAndTyping(OWNER, { key: { id: 'READ-1' } });
    bridge.stopTyping(OWNER);
    assert.ok(fake.read.some((k) => k.id === 'READ-1'), 'message should be marked read');
    const types = fake.presence.map((p) => p.type);
    assert.ok(types.includes('composing'), 'should show typing');
    assert.equal(types.at(-1), 'paused', 'typing must stop after the reply');
  });

  await t.test('protects pairing pages with the pairing token', async () => {
    const qrForbidden = await request(port, { method: 'GET', path: '/qr' });
    assert.equal(qrForbidden.status, 403);
    // Best practice: token in URL is accepted once to establish a secure session
    // cookie, then redirected to a clean URL (token must not remain in URL).
    const qrOk = await request(port, { method: 'GET', path: `/qr?token=${bridge.PAIR_TOKEN}`, maxRedirects: 1 });
    assert.equal(qrOk.status, 200);
    assert.match(qrOk.text, /phone code/);
    assert.equal(qrOk.redirect && qrOk.redirect.status, 302);
    assert.equal(qrOk.redirect && qrOk.redirect.location, '/qr');
    const pairForbidden = await request(port, { method: 'GET', path: '/pair' });
    assert.equal(pairForbidden.status, 403);
  });

  await t.test('generates an 8-character pairing code only on submit', async () => {
    // Opening the page (via secure token bootstrap -> clean URL) must not create a code.
    const page = await request(port, {
      method: 'GET',
      path: `/pair?token=${bridge.PAIR_TOKEN}&phone=${OWNER}`,
      maxRedirects: 1,
    });
    assert.equal(page.status, 200);
    assert.equal(page.redirect && page.redirect.status, 302);
    assert.match(page.redirect.location, /^\/pair(\?phone=|$)/);
    assert.doesNotMatch(page.text, /ABCD-1234/);
    // Use the secure session cookie from bootstrap (no token in URL).
    const cookie = (page.redirect.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).join('; ');
    const response = await request(port, {
      method: 'POST',
      path: '/pair',
      body: { phone: OWNER },
      cookie,
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

  await t.test('group approval prompts DM owners with context when no owner is in the group', async () => {
    bridge.pendingPerms.clear();
    const group = '2348000000000-123@g.us';
    const member = '2348999999999';
    const sock = bridge.getSock();
    sock.groupMetadata = async () => ({ participants: [{ id: `${member}@s.whatsapp.net` }] });
    fake.sent.length = 0;
    const p = await bridge.createPermissionRequest(group, member, 'hello there', { key: { id: 'TRIGGER' } });
    assert.ok(p, 'request should be created');
    const dms = fake.sent.filter((m) => String(m.to).endsWith('@s.whatsapp.net'));
    assert.equal(dms.length, CONFIG.owners.length, 'every owner is DMd');
    for (const owner of CONFIG.owners) {
      assert.ok(dms.some((m) => m.to === `${owner}@s.whatsapp.net`), `${owner} must be DMd`);
    }
    const sent = dms.at(-1);
    assert.match(sent.content.text, /Group approval needed/);
    assert.match(sent.content.text, /hello there/, 'the DM must include the actual request');
    assert.ok(sent.content.text.includes(group), 'the DM must identify the group');
    assert.equal(fake.sent.some((m) => m.to === group), false, 'a group with no owner would never see a group-only prompt');
    bridge.pendingPerms.clear();
  });

  await t.test('group approval prompts stay in the group when an owner is present', async () => {
    bridge.pendingPerms.clear();
    const group = '2348000000000-124@g.us';
    const member = '2348999999999';
    const sock = bridge.getSock();
    sock.groupMetadata = async () => ({
      participants: [{ id: `${member}@s.whatsapp.net` }, { id: `${OWNER}@s.whatsapp.net` }],
    });
    fake.sent.length = 0;
    const p = await bridge.createPermissionRequest(group, member, 'hello there', { key: { id: 'TRIGGER2' } });
    assert.ok(p, 'request should be created');
    const sent = fake.sent.at(-1);
    assert.equal(sent.to, group, 'prompt must go to the group when an owner is there');
    assert.match(sent.content.text, /Group permission needed/);
    assert.equal(fake.sent.some((m) => m.to === `${OWNER}@s.whatsapp.net`), false, 'no owner DM when the prompt is in the group');
    bridge.pendingPerms.clear();
  });

  await t.test('owners reach InstaBox directly but see a clear config error', async () => {
    const response = await post({ action: 'vps_exec', command: 'id', sender: OWNER });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /not configured/);
  });

  await t.test('vps file transport is owner-only and needs InstaBox', async () => {
    const member = '2348000000000';
    const denied = await post({ action: 'vps_upload', path: '/tmp/x', data: 'AAAA', sender: member });
    assert.equal(denied.status, 400);
    assert.match(denied.json.msg, /only the owner/);

    const badPath = await post({ action: 'vps_upload', path: 'relative', data: 'AAAA', sender: OWNER });
    assert.equal(badPath.status, 400);
    assert.match(badPath.json.msg, /absolute/);

    const empty = await post({ action: 'vps_upload', path: '/tmp/x', data: '', sender: OWNER });
    assert.equal(empty.status, 400);
    assert.match(empty.json.msg, /empty/);

    const noKey = await post({ action: 'vps_download', path: '/tmp/x', sender: OWNER });
    assert.equal(noKey.status, 400);
    assert.match(noKey.json.msg, /not configured/);
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

  await t.test('resolves anonymous group senders to phone numbers', async () => {
    // A participant's phone number lives in `jid`/`phoneNumber`; `id`/`lid` may
    // both be the anonymous LID. Getting this wrong drops every group message
    // with "could not resolve sender to a phone number".
    assert.equal(
      bridge.pnFromParticipant({ id: '100000000000001@lid', jid: '2348000000001@s.whatsapp.net' }),
      '2348000000001',
    );
    assert.equal(bridge.pnFromParticipant({ id: '2348000000002@s.whatsapp.net' }), '2348000000002');
    assert.equal(bridge.pnFromParticipant({ id: '100000000000003@lid' }), '');
    assert.equal(bridge.pnFromParticipant(null), '');

    bridge.rememberLidContacts([
      { id: '100000000000004@lid', jid: '2348000000004@s.whatsapp.net' },
      { id: '2348000000005@s.whatsapp.net', lid: '100000000000005@lid' },
    ]);
    assert.equal(bridge.lidContacts.get('100000000000004'), '2348000000004');
    assert.equal(bridge.lidContacts.get('100000000000005'), '2348000000005');

    const sock = bridge.getSock();
    sock.groupMetadata = async () => ({
      participants: [
        { id: '100000000000006@lid', jid: '2348000000006@s.whatsapp.net', admin: null },
      ],
    });
    const phone = await bridge.resolvePhone('100000000000006@lid', { key: { remoteJid: GROUP } });
    assert.equal(phone, '2348000000006');
  });

  await t.test('sending is allowed to anyone who can DM Liam', async () => {
    const known = '2348111111111';
    bridge.setDmOpen(false);
    bridge.rememberKnownMember(known);
    assert.throws(() => bridge.assertAllowed(known), /allowlist/, 'closed DMs reject a known member');
    bridge.setDmOpen(true);
    assert.doesNotThrow(() => bridge.assertAllowed(known), 'open DMs allow a known member');
    assert.throws(() => bridge.assertAllowed('2348999999999'), /allowlist/, 'an unknown number is still rejected');
    bridge.setDmOpen(false);
  });

  await t.test('re-sends a changed permission prompt up to the cap, then requires a fresh request', async () => {
    bridge.pendingPerms.clear();
    const group = '2348000000000-125@g.us';
    const member = '2348999999999';
    const sock = bridge.getSock();
    sock.groupMetadata = async () => ({ participants: [{ id: `${OWNER}@s.whatsapp.net` }] });
    fake.sent.length = 0;
    const p1 = await bridge.createPermissionRequest(group, member, 'first', { key: { id: 'T1' } });
    assert.equal(fake.sent.length, 1, 'the first request sends one prompt');
    const p2 = await bridge.createPermissionRequest(group, member, 'first', { key: { id: 'T2' } });
    assert.equal(p2.id, p1.id, 'the same member keeps one pending request');
    assert.equal(fake.sent.length, 1, 'an unchanged request is not re-sent');
    await bridge.createPermissionRequest(group, member, 'second', { key: { id: 'T3' } });
    assert.equal(fake.sent.length, 2, 'a changed request is re-sent');
    await bridge.createPermissionRequest(group, member, 'third', { key: { id: 'T4' } });
    assert.equal(fake.sent.length, 3);
    // Past the cap, later edits must be rejected rather than silently approved
    // against a prompt the owner never saw.
    await assert.rejects(
      () => bridge.createPermissionRequest(group, member, 'fourth', { key: { id: 'T5' } }),
      (e) => e && e.code === 'permission_reprompt_limit',
    );
    assert.equal(fake.sent.length, 3, 'no extra prompt is sent after the cap');
    assert.equal(bridge.pendingPerms.size, 0, 'the rejected request is dropped so a fresh one is required');
    bridge.pendingPerms.clear();
  });

  await t.test('a pending tool approval in another group does not block a permission', async () => {
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
    const groupA = '2348000000000-1@g.us';
    const groupB = '2348000000000-2@g.us';
    const memberB = '2348222222222';
    await bridge.createToolApproval('vps_exec', { command: 'id' }, '2348111111111',
      { chat: groupA, isGroup: true });
    await bridge.createPermissionRequest(groupB, memberB, 'hi', { key: { id: 'T' } });
    const handled = await bridge.handleApprovalCommand('yes', OWNER, groupB, true);
    assert.equal(handled, true);
    assert.ok(bridge.TEMP[groupB] && bridge.TEMP[groupB][memberB] > 0, 'the permission is approved');
    assert.equal(bridge.pendingTools.size, 1, 'the unrelated tool approval is untouched');
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
  });

  await t.test('labels media Liam cannot read', async () => {
    assert.equal(bridge.mediaPlaceholder({ audioMessage: {} }, 'audioMessage'), '[sent a voice note]');
    assert.equal(bridge.mediaPlaceholder({ imageMessage: {} }, 'imageMessage'), '[sent an image]');
    assert.equal(bridge.mediaPlaceholder({ videoMessage: {} }, 'videoMessage'), '[sent a video]');
    assert.equal(bridge.mediaPlaceholder({ documentMessage: {} }, 'documentMessage'), '[sent a document]');
    assert.equal(bridge.mediaPlaceholder({ stickerMessage: {} }, 'stickerMessage'), '[sent a sticker]');
    assert.equal(bridge.mediaPlaceholder({ conversation: 'hi' }, 'conversation'), '');
    assert.equal(bridge.mediaPlaceholder(null, 'imageMessage'), '');
  });

  await t.test('bridge state survives a snapshot and re-apply', () => {
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
    bridge.heldReplies.length = 0;
    const group = '2348000000000-9@g.us';
    const member = '2348333333333';
    bridge.TEMP[group] = { [member]: Date.now() };
    bridge.pendingPerms.set('p1', {
      id: 'p1', jid: group, phone: member, text: 'hi', ts: Date.now(),
      promptedText: 'hi', promptCount: 1,
    });
    bridge.pendingTools.set('t1', {
      id: 't1', action: 'vps_exec', payload: { command: 'id' }, actor: member,
      chat: group, isGroup: true, ts: Date.now(),
    });
    bridge.heldReplies.push({ target: member + '@s.whatsapp.net', text: 'held', options: { quoted: {} }, at: Date.now() });

    const snap = bridge.bridgeStateSnapshot();
    assert.equal(snap.v, 1);
    assert.equal(snap.perms.length, 1);
    assert.equal(snap.tools.length, 1);
    assert.equal(snap.held.length, 1);
    assert.equal(snap.held[0].options, undefined, 'the live quoted object is not persisted');
    assert.ok(snap.temp[group][member] > 0);

    // Apply onto a clean slate, as a fresh process would.
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
    bridge.heldReplies.length = 0;
    delete bridge.TEMP[group];
    bridge.applyBridgeState(snap);

    assert.equal(bridge.pendingPerms.has('p1'), true);
    assert.equal(bridge.pendingTools.has('t1'), true);
    assert.equal(bridge.TEMP[group][member] > 0, true);
    assert.equal(bridge.heldReplies.length, 1);
    assert.equal(bridge.heldReplies[0].text, 'held');
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
    bridge.heldReplies.length = 0;
    delete bridge.TEMP[group];
  });

  await t.test('drops held replies that expired while Liam was down', () => {
    const now = Date.now();
    bridge.heldReplies.length = 0;
    bridge.applyBridgeState({
      savedAt: now,
      held: [
        { target: '2348000000000@s.whatsapp.net', text: 'fresh', at: now },
        { target: '2348000000000@s.whatsapp.net', text: 'stale', at: now - (4 * 60 * 60 * 1000) },
      ],
    });
    assert.equal(bridge.heldReplies.length, 1);
    assert.equal(bridge.heldReplies[0].text, 'fresh');
    bridge.heldReplies.length = 0;
  });

  await t.test('loadBridgeState restores the local copy when Supabase is off', async () => {
    const group = '2348000000000-8@g.us';
    bridge.pendingPerms.clear();
    bridge.pendingTools.clear();
    delete bridge.TEMP[group];
    bridge.TEMP[group] = { '2348444444444': Date.now() };
    bridge.saveBridgeStateLocal();
    delete bridge.TEMP[group];
    await bridge.loadBridgeState();
    assert.equal(bridge.TEMP[group]['2348444444444'] > 0, true);
    delete bridge.TEMP[group];
  });

  await t.test('a loopback tool token cannot claim an owner identity', async () => {
    const response = await request(port, {
      body: { action: 'send', to: OWNER, text: 'hello', sender: OWNER },
      token,
    });
    assert.equal(response.status, 403);
    assert.match(response.json.msg, /owner token/);
  });

  await t.test('GET pairing actions only bootstrap a cookie; the action needs POST', async () => {
    for (const actionPath of ['/cancelpair', '/reset']) {
      const forbidden = await request(port, { method: 'GET', path: actionPath, token: bridge.PAIR_TOKEN });
      assert.equal(forbidden.status, 405, `${actionPath} with a header token must require POST`);
      const bootstrap = await request(port, {
        method: 'GET', path: `${actionPath}?token=${bridge.PAIR_TOKEN}`,
      });
      assert.equal(bootstrap.status, 302, `${actionPath} query token bootstraps a session`);
      assert.equal(bootstrap.headers.location, actionPath);
      const cookie = (bootstrap.headers['set-cookie'] || [])
        .map((c) => String(c).split(';')[0]).join('; ');
      const withCookie = await request(port, { method: 'GET', path: actionPath, cookie });
      assert.equal(withCookie.status, 405, `${actionPath} cookie GET must not run the action`);
    }
  });

  await t.test('pair POST rejects a cross-site origin', async () => {
    const response = await request(port, {
      method: 'POST', path: '/pair', body: { phone: OWNER },
      token: bridge.PAIR_TOKEN,
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(response.status, 403);
  });

  await t.test('diagnostic sends only target the owner', async () => {
    bridge.outboundLog.length = 0;
    bridge._setState('ready', 'test');
    try {
      const diag = (to) => request(port, {
        method: 'GET', path: `/diag?probe=send&to=${to}`, token: bridge.PAIR_TOKEN,
      });
      const blocked = await diag('2348999999999');
      assert.equal(blocked.status, 200);
      assert.equal(blocked.json.sendProbe.ok, false);
      assert.match(blocked.json.sendProbe.error, /owner/);
      const allowed = await diag(OWNER);
      assert.equal(allowed.status, 200);
      assert.equal(allowed.json.sendProbe.ok, true);
    } finally {
      bridge._setState('starting', '');
    }
  });

  await t.test('diagnostic probe subprocess receives the owner token', async () => {
    const source = fs.readFileSync(path.join(APP, 'whatsapp_bridge.js'), 'utf8');
    const start = source.indexOf('function runProbeScript');
    const block = source.slice(start, start + 2000);
    assert.match(block, /LIAM_OWNER_TOKEN:\s*OWNER_TOKEN/);
  });

  await t.test('captioned media keeps its caption and its attachment hint', async () => {
    assert.equal(bridge.displayText({ imageMessage: { caption: 'look' } }, 'imageMessage'), '[sent an image]: look');
    assert.equal(bridge.displayText({ imageMessage: {} }, 'imageMessage'), '[sent an image]');
    assert.equal(bridge.displayText({ conversation: 'hi' }, 'conversation'), 'hi');
    assert.equal(bridge.displayText({ extendedTextMessage: { text: 'yo' } }, 'extendedTextMessage'), 'yo');
  });

  await t.test('a burst from one new LID shares one network lookup', async () => {
    const lid = '100000000000099@lid';
    const sock = bridge.getSock();
    let calls = 0;
    sock.groupMetadata = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { participants: [{ id: lid, jid: '2348999999999@s.whatsapp.net' }] };
    };
    const key = { remoteJid: GROUP };
    const results = await Promise.all([
      bridge.resolvePhone(lid, { key }),
      bridge.resolvePhone(lid, { key }),
      bridge.resolvePhone(lid, { key }),
    ]);
    assert.deepEqual(results, ['2348999999999', '2348999999999', '2348999999999']);
    assert.equal(calls, 1, 'concurrent lookups for one LID must be coalesced');
  });
});

test('a reply survives a socket that is briefly closed', async (t) => {
  const fake = bridge.getSock();
  await t.test('retries once after a connection-closed error', async () => {
    const original = fake.sendMessage.bind(fake);
    let calls = 0;
    fake.sendMessage = async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('Connection Closed');
      return original(...args);
    };
    try {
      const sent = await bridge.wa.sendMessage('2347035634340', 'hello');
      assert.equal(calls, 2, 'the send should be retried exactly once');
      assert.ok(sent && sent.key && sent.key.id, 'the retry should return a real receipt');
    } finally {
      fake.sendMessage = original;
    }
  });

  await t.test('does not retry a payload error', async () => {
    const original = fake.sendMessage.bind(fake);
    let calls = 0;
    fake.sendMessage = async () => {
      calls += 1;
      throw new Error('message is too long');
    };
    try {
      await assert.rejects(() => bridge.wa.sendMessage('2347035634340', 'hello'), /too long/);
      assert.equal(calls, 1, 'a bad payload must not be retried');
    } finally {
      fake.sendMessage = original;
    }
  });
});

// TS-8: the keep-alive test above only checked typeof and "does not throw".
// Verify the real behaviour in a subprocess: with a public URL and the agent
// guards off, startKeepAlive() must actually ping /health. The 10-minute default
// interval is fired immediately by a local setInterval shim so this stays fast.
test('keep-alive pings the public /health URL', async () => {
  const probePath = path.join(APP, 'keepalive_probe.js');
  fs.writeFileSync(probePath, [
    "'use strict';",
    "const http = require('node:http');",
    "let hits = 0;",
    "const server = http.createServer((req, res) => {",
    "  if (req.url === '/health') hits += 1;",
    "  res.writeHead(200); res.end('ok');",
    "});",
    "server.listen(0, '127.0.0.1', () => {",
    "  process.env.LIAM_PUBLIC_URL = 'http://127.0.0.1:' + server.address().port;",
    "  delete process.env.LIAM_DISABLE_AGENT;",
    "  delete process.env.LIAM_DISABLE_KEEPALIVE;",
    "  delete process.env.LIAM_KEEPALIVE_MS;",
    "  const realSetInterval = global.setInterval;",
    "  global.setInterval = (fn, ms, ...args) => {",
    "    if (ms === 600000) { setImmediate(fn); return { unref() {} }; }",
    "    return realSetInterval(fn, ms, ...args);",
    "  };",
    "  const bridge = require('./whatsapp_bridge.js');",
    "  bridge.startKeepAlive();",
    "  setTimeout(() => { process.stdout.write('KEEPALIVE_RESULT:' + JSON.stringify({ hits }) + '\\n'); process.exit(0); }, 400);",
    "});",
  ].join('\n'));

  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [probePath], {
    cwd: APP,
    env: { ...process.env, LIAM_DATA_DIR: DATA, LIAM_PORT: '0' },
    timeout: 10000,
  });
  const match = /KEEPALIVE_RESULT:(\{.*\})/.exec(stdout);
  assert.ok(match, 'the probe should report its result');
  const { hits } = JSON.parse(match[1]);
  assert.ok(hits >= 1, 'keep-alive should ping /health at least once');
});
