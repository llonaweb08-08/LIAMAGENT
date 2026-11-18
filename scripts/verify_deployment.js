#!/usr/bin/env node
'use strict';

// Verify a deployed Liam without exposing the pairing token.
//
//   node scripts/verify_deployment.js https://liam-whatsapp-agent.onrender.com
//   LIAM_PUBLIC_URL=https://... npm run verify
//
// An explicit URL argument wins over LIAM_PUBLIC_URL, with a warning if both
// are set to different values (values are never echoed).
//
// Exit code 0 means /health is 200 and /ready is 200 (WhatsApp linked and the
// Python agent is running). --allow-not-ready exits 0 when only /health is up;
// useful right after a deploy, before pairing.

const cliUrl = process.argv.slice(2).find((value) => /^https?:\/\//i.test(value)) || '';
const envUrl = String(process.env.LIAM_PUBLIC_URL || '');
if (cliUrl && envUrl && cliUrl.replace(/\/+$/, '') !== envUrl.replace(/\/+$/, '')) {
  console.warn('warning: URL argument takes precedence over LIAM_PUBLIC_URL; ignoring the environment value.');
}
const base = (cliUrl || envUrl).replace(/\/+$/, '');
const allowNotReady = process.argv.includes('--allow-not-ready');

if (!/^https?:\/\//i.test(base)) {
  console.error('Usage: node scripts/verify_deployment.js https://your-service.onrender.com [--allow-not-ready]');
  process.exitCode = 2;
} else {
  verify(base).catch((error) => {
    console.error(`verify failed: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

async function get(path) {
  const response = await fetch(base + path, {
    headers: { 'User-Agent': 'liam-verify' },
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) {}
  return { status: response.status, json, text };
}

async function verify(target) {
  console.log(`Checking ${target}`);

  const health = await get('/health');
  console.log(`/health  HTTP ${health.status} ${health.text.slice(0, 200)}`);
  if (health.status !== 200) {
    console.error('The service is not alive. Check the Render deploy logs.');
    process.exitCode = 1;
    return;
  }

  const status = await get('/status');
  console.log(`/status  HTTP ${status.status}`);
  if (status.json) {
    const keys = ['status', 'whatsappReady', 'agentRunning', 'needsQr', 'hasSessionData'];
    for (const key of keys) console.log(`  ${key}: ${String(status.json[key])}`);
  }

  const ready = await get('/ready');
  console.log(`/ready   HTTP ${ready.status} ${ready.text.slice(0, 300)}`);
  if (ready.status === 200) {
    console.log('\nLiam is live.');
    process.exitCode = 0;
    return;
  }

  console.error('\nLiam is alive but not ready.');
  if (status.json && status.json.needsQr) {
    console.error('WhatsApp is not linked. Build the /pair URL from LIAM_PAIR_TOKEN');
    console.error('in the Render dashboard (logs show only a redacted token), or open');
    console.error('/pair and paste the token into the form to get an 8-digit code.');
  } else if (status.json && status.json.hasSessionData) {
    console.error('A WhatsApp session is present but the client is not ready yet; check the logs.');
  } else {
    console.error('No saved WhatsApp session was found; pair with /pair.');
  }
  process.exitCode = allowNotReady ? 0 : 1;
}
