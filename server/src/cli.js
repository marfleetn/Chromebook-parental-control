#!/usr/bin/env node
// @chpc/server — tiny maintenance CLI (used by the `chpc` helper the installer
// creates; also handy in Docker: `docker compose exec chpc node server/src/cli.js …`).
//
//   node server/src/cli.js status       # where the DB is, whether a PIN is set, counts
//   node server/src/cli.js reset-pin    # forget the stored PIN; restart the server to get a new setup code
import path from 'node:path';
import fs from 'node:fs';
import { openDb, getSetting, listKids, listDevices } from './db.js';

const dbFile = process.env.CHPC_DB || path.join(process.cwd(), 'data', 'chpc.db');
const cmd = process.argv[2];

function usage() {
  console.log('usage: cli.js <status|reset-pin>');
  process.exit(cmd ? 1 : 0);
}

if (!cmd || cmd === 'help' || cmd === '--help') usage();
if (!fs.existsSync(dbFile)) {
  console.error(`database not found at ${dbFile} (is CHPC_DB set? has the server run once?)`);
  process.exit(1);
}
const db = openDb(dbFile);
try {
  if (cmd === 'status') {
    const hash = getSetting(db, 'pinHash', null);
    const envPin = !!process.env.CHPC_GUARDIAN_PIN;
    const kids = listKids(db);
    console.log(`database:   ${dbFile}`);
    console.log(`PIN:        ${envPin ? 'set by CHPC_GUARDIAN_PIN' : hash ? 'stored in database' : 'NOT SET — first-run setup pending'}`);
    console.log(`time zone:  ${getSetting(db, 'tz', 'Europe/London')}`);
    console.log(`children:   ${kids.length}`);
    console.log(`devices:    ${listDevices(db).length}`);
    const setupFile = path.join(path.dirname(dbFile), 'setup-code.txt');
    if (!hash && !envPin && fs.existsSync(setupFile)) {
      console.log(`setup code: ${fs.readFileSync(setupFile, 'utf8').trim()}`);
    }
  } else if (cmd === 'reset-pin') {
    if (process.env.CHPC_GUARDIAN_PIN) {
      console.error('the PIN is set by CHPC_GUARDIAN_PIN; change it in the environment / service file instead.');
      process.exit(1);
    }
    db.prepare('DELETE FROM settings WHERE key = ?').run('pinHash');
    console.log('stored PIN removed. Restart the server: it will print a new setup code.');
  } else {
    usage();
  }
} finally {
  db.close();
}
