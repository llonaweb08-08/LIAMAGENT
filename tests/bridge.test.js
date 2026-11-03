'use strict';

// Exercises the bridge's local HTTP API against a stubbed WhatsApp client.
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
fs.copyFileSync(path.join(ROOT, 'liam_config.json'), path.join(APP, 'liam_config.json'));

const whatsappStubDir = path.join(APP, 'node_modules', 'whatsapp-web.js');
fs.mkdirSync(whatsappStubDir, { recursive: true });
fs.writeFileSync(path.join(whatsappStubDir, 'index.js'), [
  "'use strict';",
  "const { EventEmitter } = require('node:events');",
  'class FakeClient extends EventEmitter {',
  '  constructor(options) {',
  '    super();',
  '    this.options = options;',
  "    this.info = { wid: { _serialized: '2340000000000@c.us' } };",
  '    this.sent = [];',
  '    this.chats = new Map();',
  '    global.__liamFakeClient = this;',
  '  }',
  '  initialize() {}',
  '  async sendMessage(to, content, options) {',
  '    this.sent.push({ to, content, options });',
  "    return { id: { _serialized: 'MSG-' + this.sent.length } };",
  '  }',
  '  async getChatById(jid) {',
  "    if (!this.chats.has(jid)) throw new Error('chat not found');",
  '    return this.chats.get(jid);',
  '  }',
  '}',
  'class FakeLocalAuth { constructor(options) { this.options = options; } }',
  'const MessageMedia = { fromFilePath: (file) => ({ file }) };',
  'module.exports = { Client: FakeClient, LocalAuth: FakeLocalAuth, MessageMedia };',
].join('\n'));

const qrStubDir = path.join(APP, 'node_modules', 'qrcode');
fs.mkdirSync(qrStubDir, { recursive: true });
fs.writeFileSync(path.join(qrStubDir, 'index.js'),
  "module.exports = { toFile: async () => {} };\n");

process.env.LIAM_DATA_DIR = DATA;
process.env.LIAM_PORT = '0';
process.env.LIAM_DM_ALLOWLIST = '2347000000009';

const bridge = require(path.join(APP, 'whatsapp_bridge.js'));
const client = bridge.client || global.__liamFakeClient;
const CONFIG = require(path.join(APP, 'liam_config.json'));
const OWNER = CONFIG.owners[0];
const GROUP = '120363000000000000@g.us';

after(() => {
  clearInterval(bridge.sweepTimer);
  bridge.server.close();
  if (typeof bridge.server.closeAllConnections === 'function') {
    bridge.server.closeAllConnections();
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
      host: '127.0.0.1', port, path: '/', method, headers, agent: false,
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
  const { port } = bridge.server.address();
  const token = fs.readFileSync(path.join(DATA, 'tool_token'), 'utf8').trim();
  const post = (body, extra = {}) => request(port, { body, token, ...extra });

  await t.test('accepts an authenticated message to an owner', async () => {
    const response = await post({ action: 'send', to: OWNER, text: 'hello' });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    const sent = client.sent.at(-1);
    assert.equal(sent.to, `${OWNER}@c.us`);
    assert.equal(sent.content, 'hello');
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
    const response = await post({ action: 'send', to: '2347999999999', text: 'hi' });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /allowlist/);
  });

  await t.test('accepts LIAM_DM_ALLOWLIST recipients', async () => {
    const response = await post({ action: 'send', to: '2347000000009', text: 'hi' });
    assert.equal(response.status, 200);
    assert.equal(client.sent.at(-1).to, '2347000000009@c.us');
  });

  await t.test('rejects invalid recipient formats', async () => {
    const response = await post({ action: 'send', to: 'not-a-number', text: 'hi' });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /recipient/);
  });

  await t.test('sends an image only from the outbox', async () => {
    const outside = path.join(APP, 'secret.txt');
    fs.writeFileSync(outside, 'secret');
    const blocked = await post({ action: 'image', to: OWNER, path: outside });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.msg, /outside the outbox/);

    const image = path.join(OUTBOX, 'test.png');
    fs.writeFileSync(image, Buffer.from('PNGDATA'));
    const allowed = await post({ action: 'image', to: OWNER, path: image, text: 'caption' });
    assert.equal(allowed.status, 200);
    const sent = client.sent.at(-1);
    assert.equal(sent.content.file, fs.realpathSync(image));
    assert.equal(sent.options.caption, 'caption');
  });

  await t.test('rejects missing outbox files', async () => {
    const response = await post({
      action: 'image', to: OWNER, path: path.join(OUTBOX, 'missing.png'),
    });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /not found/);
  });

  await t.test('sends voice notes with a real mimetype', async () => {
    const voice = path.join(OUTBOX, 'voice.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const response = await post({
      action: 'voice', to: OWNER, path: voice, mimetype: 'audio/wav',
    });
    assert.equal(response.status, 200);
    const sent = client.sent.at(-1);
    assert.equal(sent.options.sendAudioAsVoice, true);
    assert.equal(sent.options.mimetype, 'audio/wav');

    const inferred = await post({ action: 'voice', to: OWNER, path: voice });
    assert.equal(inferred.status, 200);
    assert.equal(client.sent.at(-1).options.mimetype, 'audio/wav');
  });

  await t.test('rejects unsupported audio types', async () => {
    const voice = path.join(OUTBOX, 'voice2.wav');
    fs.writeFileSync(voice, Buffer.from('RIFF'));
    const response = await post({
      action: 'voice', to: OWNER, path: voice, mimetype: 'text/plain',
    });
    assert.equal(response.status, 400);
  });

  await t.test('leaves a group through the real chat API', async () => {
    let left = false;
    client.chats.set(GROUP, { leave: async () => { left = true; } });
    const response = await post({ action: 'leave', jid: GROUP });
    assert.equal(response.status, 200);
    assert.equal(left, true);
  });

  await t.test('refuses chats that cannot be left', async () => {
    const noLeave = '120363000000000001@g.us';
    client.chats.set(noLeave, {});
    const response = await post({ action: 'leave', jid: noLeave });
    assert.equal(response.status, 400);
  });

  await t.test('validates permission changes', async () => {
    const allowed = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: true,
    });
    assert.equal(allowed.status, 200);
    const denied = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: false,
    });
    assert.equal(denied.status, 200);
    const badWho = await post({
      action: 'permission', jid: GROUP, who: 'x', allow: true,
    });
    assert.equal(badWho.status, 400);
    const badAllow = await post({
      action: 'permission', jid: GROUP, who: OWNER, allow: 'yes',
    });
    assert.equal(badAllow.status, 400);
  });

  await t.test('writes the stop flag atomically', async () => {
    const response = await post({ action: 'stop' });
    assert.equal(response.status, 200);
    assert.equal(fs.readFileSync(path.join(DATA, 'stop_flag'), 'utf8'), '1');
  });

  await t.test('rate-limits outbound messages', async () => {
    bridge.outboundLog.length = 0;
    for (let i = 0; i < 20; i += 1) {
      const response = await post({ action: 'send', to: OWNER, text: `burst ${i}` });
      assert.equal(response.status, 200);
    }
    const response = await post({ action: 'send', to: OWNER, text: 'too many' });
    assert.equal(response.status, 400);
    assert.match(response.json.msg, /too many/);
  });
});
