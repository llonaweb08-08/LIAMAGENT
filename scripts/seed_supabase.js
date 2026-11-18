#!/usr/bin/env node
'use strict';

// Upload the local Baileys WhatsApp session (and memory DB) to Supabase so a
// free Render instance can restore them after a restart. Run this from a
// machine that already has Liam linked, using the same Baileys version:
//
//   PowerShell:
//     $env:LIAM_DATA_DIR="C:\path\to\baileys-data"
//     $env:SUPABASE_URL="https://....supabase.co"
//     $env:SUPABASE_SECRET_KEY="sb_secret_..."
//     npm run seed:supabase
//
// A whatsapp-web.js/Chromium profile cannot be imported; pair on Render instead.
// The Baileys archive is only creds.json plus app-state keys, well under 1 MB.

const fs = require('fs');
const os = require('os');
const path = require('path');
const sync = require('../supabase_sync');

function dataDir() {
  if (process.env.LIAM_DATA_DIR) return process.env.LIAM_DATA_DIR;
  return path.join(process.env.LOCALAPPDATA || os.homedir(), 'LiamWhatsApp');
}

function describeUpload(part) {
  if (!part) return { text: 'NO (no result returned)', failed: true };
  if (part.ok) return { text: 'yes', failed: false };
  const reason = part.reason || part.error || 'unknown error';
  // "skipped" is informational (no local DB, or nothing changed); a failed
  // upload is a real error and must make the command exit non-zero.
  if (part.skipped) return { text: `no (${reason})`, failed: false };
  return { text: `NO (${reason})`, failed: true };
}

async function main() {
  if (!sync.configured()) {
    console.error('SUPABASE_URL and SUPABASE_SECRET_KEY must both be set.');
    process.exitCode = 2;
    return;
  }
  const base = path.resolve(dataDir());
  const session = path.join(base, 'liam_session');
  if (!fs.existsSync(session)) {
    console.error(`No WhatsApp session found at ${session}`);
    console.error('Pair Liam locally first, or set LIAM_DATA_DIR to the right directory.');
    process.exitCode = 2;
    return;
  }

  // supabase_sync uses LIAM_DB when it is set; otherwise this points it at the
  // project's liam_memory.db, which is where the agent stores memory locally.
  const dbDir = process.env.LIAM_DB
    ? path.dirname(path.resolve(process.env.LIAM_DB))
    : path.resolve(__dirname, '..');

  console.log(`Uploading ${session} and the memory DB to Supabase...`);
  const result = await sync.backupNow(base, session, dbDir);
  console.log('');
  const sessionUpload = describeUpload(result && result.session);
  const dbUpload = describeUpload(result && result.db);
  console.log('WhatsApp login uploaded:', sessionUpload.text);
  console.log('Memory database uploaded:', dbUpload.text);
  if (result && result.session && result.session.entries) {
    console.log('Login files saved:', result.session.entries);
  }
  if (!result || !result.ok) console.log(JSON.stringify(result, null, 2));
  if (!result || sessionUpload.failed || dbUpload.failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`seed failed: ${error && error.message ? error.message : String(error)}`);
  process.exitCode = 1;
});
