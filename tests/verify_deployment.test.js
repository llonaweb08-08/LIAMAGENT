'use strict';

// Mock-server tests for scripts/verify_deployment.js (TS-15). No real service,
// token, or network access is used: the child process only talks to a local
// HTTP server that answers /health, /status and /ready.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { once } = require('node:events');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verify_deployment.js');

let scenario;
let server;
let baseUrl;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

before(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (pathname === '/health') {
      return send(res, scenario.healthStatus, { ok: scenario.healthStatus === 200, status: 'alive' });
    }
    if (pathname === '/status') return send(res, 200, scenario.status);
    if (pathname === '/ready') {
      return send(res, scenario.readyStatus, { ok: scenario.readyStatus === 200 });
    }
    return send(res, 404, { ok: false });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!server) return;
  try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {}
  const closed = once(server, 'close');
  server.close();
  await closed;
});

function liveScenario() {
  return {
    healthStatus: 200,
    readyStatus: 200,
    status: {
      status: 'ready', whatsappReady: true, agentRunning: true,
      needsQr: false, hasSessionData: true,
    },
  };
}

function runVerify(args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, LIAM_PUBLIC_URL: '', ...extraEnv },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('verify_deployment exits 0 for a live deployment', async () => {
  scenario = liveScenario();
  const result = await runVerify([baseUrl]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Liam is live/);
});

test('verify_deployment exits 1 when WhatsApp is not linked', async () => {
  scenario = liveScenario();
  scenario.readyStatus = 503;
  scenario.status.whatsappReady = false;
  scenario.status.needsQr = true;
  const result = await runVerify([baseUrl]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /not linked/);
});

test('--allow-not-ready only requires /health', async () => {
  scenario = liveScenario();
  scenario.readyStatus = 503;
  scenario.status.needsQr = true;
  const result = await runVerify([baseUrl, '--allow-not-ready']);
  assert.equal(result.code, 0, result.stderr);
});

test('verify_deployment exits 1 when /health is down', async () => {
  scenario = liveScenario();
  scenario.healthStatus = 503;
  const result = await runVerify([baseUrl]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /not alive/);
});

test('an explicit URL argument wins over LIAM_PUBLIC_URL and warns', async () => {
  scenario = liveScenario();
  const result = await runVerify([baseUrl], { LIAM_PUBLIC_URL: 'http://127.0.0.1:1' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /takes precedence over LIAM_PUBLIC_URL/);
});

test('LIAM_PUBLIC_URL still works when no URL argument is given', async () => {
  scenario = liveScenario();
  const result = await runVerify([], { LIAM_PUBLIC_URL: baseUrl });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Liam is live/);
});
