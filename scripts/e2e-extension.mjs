#!/usr/bin/env node
/**
 * End-to-end check of the Chrome extension against a real Chromium.
 *
 * Starts the API on a random loopback port with a PIN, creates a child with a
 * deny-list policy, loads `extension/` unpacked into headless Chromium via
 * Playwright, pairs it through the real popup UI, and asserts that:
 *   - Chrome accepts the generated declarativeNetRequest rules,
 *   - a denied site is redirected to the lock page with the right reason,
 *   - a policy change is picked up on refresh,
 *   - metered usage reaches the server,
 *   - unpairing requires the guardian PIN and clears every rule.
 *
 * Needs Playwright + a Chromium build. Either `npm i -D playwright && npx
 * playwright install chromium`, or point PLAYWRIGHT_MODULE at a global install.
 *
 *   node scripts/e2e-extension.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ext = path.join(root, 'extension');
const PIN = 'e2e-pin-2026';

let playwright;
try {
  const req = createRequire(import.meta.url);
  playwright = req(process.env.PLAYWRIGHT_MODULE || 'playwright');
} catch {
  console.error('playwright not found — install it (npm i -D playwright) or set PLAYWRIGHT_MODULE');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) throw new Error('E2E FAIL: ' + msg); console.log('  ok  ' + msg); };

// ---- 1) server ---------------------------------------------------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-e2e-'));
const port = 4200 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CHPC_GUARDIAN_PIN: PIN, CHPC_DB: path.join(dataDir, 'chpc.db'), CHPC_PUBLIC_DIR: path.join(root, 'web/dist') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; process.stderr.write('[server] ' + d); });
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(base + '/api/health'); if (r.ok) break; } catch { /* not yet */ }
  await sleep(100);
}
const parent = (p, init = {}) => fetch(base + '/api' + p, { ...init, headers: { 'content-type': 'application/json', 'x-guardian-pin': PIN, ...(init.headers || {}) } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const kid = (await parent('/kids', { method: 'POST', body: JSON.stringify({ name: 'E2E Kid' }) })).body.kid;
await parent(`/kids/${kid.id}/policy`, { method: 'PUT', body: JSON.stringify({ deny: ['example.com'], siteBudgets: [{ pattern: 'youtube.com', minutes: 1 }] }) });
const { code, codeDisplay } = (await parent(`/kids/${kid.id}/pairings`, { method: 'POST', body: JSON.stringify({ agentId: 'e2e chromebook' }) })).body;
console.log(`server up on ${base}, kid ${kid.id}, code ${codeDisplay}`);

// ---- 2) browser + extension ------------------------------------------------
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-e2e-profile-'));
const context = await playwright.chromium.launchPersistentContext(userDataDir, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let exitCode = 0;
const artDir = path.join(root, 'e2e-artifacts');
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(sw.url()).host;
  console.log('extension loaded:', extId);

  const rules = () => sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  await sleep(500);
  check((await rules()).length === 0, 'unpaired extension applies no rules');

  // Pair through the popup UI.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.fill('#pair-code', codeDisplay.toLowerCase());
  await popup.fill('#api-base', base);
  await popup.click('#pair-btn');
  await popup.waitForFunction(() => /Paired/.test(document.getElementById('msg').textContent), null, { timeout: 15000 });
  const msg = await popup.textContent('#msg');
  console.log('  popup:', msg.trim());
  const stored = await sw.evaluate(() => chrome.storage.local.get(['pairingCode', 'apiBase', 'ruleMode', 'ruleCount', 'kidName']));
  check(stored.pairingCode === code, 'popup stored the normalised pairing code');
  check(stored.kidName === 'E2E Kid', 'popup learned the child name from the server');
  const r1 = await rules();
  check(r1.length >= 2, `Chrome accepted ${r1.length} dynamic rules (mode ${stored.ruleMode})`);
  check(stored.ruleMode === 'regex', 'rich regex/reason rule flavour was accepted');
  check(r1.some((r) => r.action.type === 'redirect' && r.condition.regexFilter && r.condition.regexFilter.includes('example\\.com')), 'deny rule for example.com present');

  // Denied site -> lock page with reason.
  const page = await context.newPage();
  await page.goto('http://www.example.com/some/path?q=1', { waitUntil: 'commit' }).catch(() => {});
  await page.waitForURL(/pages\/blocked\.html/, { timeout: 10000 });
  const u = new URL(page.url());
  check(u.host === extId, 'denied navigation landed on the extension lock page');
  check(u.searchParams.get('code') === 'site-denied', 'lock page received code=site-denied');
  check(u.searchParams.get('url') === 'http://www.example.com', 'lock page received the scheme://host only (no path/query)');
  await page.waitForFunction(() => document.getElementById('reason').textContent === 'site-denied');
  check((await page.textContent('#title')).includes('blocked'), 'lock page renders the friendly reason');
  check((await page.textContent('#url')) === 'www.example.com', 'lock page shows the host');

  // Allowed site is not redirected (network may fail; that is fine).
  const p2 = await context.newPage();
  await p2.goto('http://allowed.invalid/', { waitUntil: 'commit', timeout: 5000 }).catch(() => {});
  await sleep(300);
  check(!/blocked\.html/.test(p2.url()), 'an undenied site is not redirected');
  await p2.close();

  // Local network stays reachable even under a block-all policy.
  await parent(`/kids/${kid.id}/policy`, { method: 'PUT', body: JSON.stringify({ internetAllowed: false }) });
  const refresh = () => popup.evaluate(() => new Promise((res) => chrome.runtime.sendMessage({ type: 'CHPC_REFRESH' }, res)));
  const rr = await refresh();
  check(rr && rr.online === true, 'refresh reached the server');
  const r2 = await rules();
  check(r2.length === 1 && r2[0].priority === 4000, 'master switch off -> single block-all rule');
  const p3 = await context.newPage();
  await p3.goto('http://neverssl.invalid/', { waitUntil: 'commit' }).catch(() => {});
  await p3.waitForURL(/code=disabled/, { timeout: 10000 });
  check(true, 'block-all redirects with code=disabled');
  await p3.close();

  // Metered usage reaches the server (server clock, batch endpoint).
  await parent(`/kids/${kid.id}/policy`, { method: 'PUT', body: JSON.stringify({ deny: ['example.com'] }) });
  await sw.evaluate(() => chrome.storage.local.set({ pendingUsage: { 'bbc.co.uk': 120, 'example.org': 60 } }));
  await refresh();
  const today = (await parent(`/kids/${kid.id}/usage/today`)).body;
  check(today.status.usedTodayMin === 3, 'metered minutes were flushed to the server');
  const left = await sw.evaluate(() => chrome.storage.local.get(['pendingUsage']));
  check(Object.keys(left.pendingUsage || {}).length === 0, 'pending usage cleared after a successful flush');

  // Unpair needs the PIN.
  await popup.reload();
  await popup.click('#show-forget-btn');
  await popup.fill('#pin', 'wrong-pin');
  await popup.click('#forget-btn');
  await popup.waitForFunction(() => /Wrong PIN/.test(document.getElementById('msg').textContent));
  check((await rules()).length >= 1, 'wrong PIN leaves the rules in place');
  await popup.fill('#pin', PIN);
  await popup.click('#forget-btn');
  await popup.waitForFunction(() => /Unpaired/.test(document.getElementById('msg').textContent), null, { timeout: 10000 });
  await sleep(300);
  check((await rules()).length === 0, 'correct PIN unpairs and removes every rule');
  const after = await sw.evaluate(() => chrome.storage.local.get(['pairingCode']));
  check(!after.pairingCode, 'pairing code forgotten');

  console.log('\nE2E PASS');
} catch (e) {
  exitCode = 1;
  console.error('\n' + (e && e.stack || e));
  try {
    fs.mkdirSync(artDir, { recursive: true });
    let i = 0;
    for (const pg of context.pages()) {
      console.error(`--- page ${i} url: ${pg.url()}`);
      await pg.screenshot({ path: path.join(artDir, `extension-page-${i}.png`) }).catch(() => {});
      i++;
    }
    const sws = context.serviceWorkers();
    if (sws[0]) {
      const st = await sws[0].evaluate(() => chrome.storage.local.get(null)).catch((x) => ({ error: String(x) }));
      console.error('--- extension storage: ' + JSON.stringify(st).slice(0, 2000));
    }
    console.error('--- server log:\n' + serverLog.slice(-3000));
    fs.writeFileSync(path.join(artDir, 'extension-server.log'), serverLog);
  } catch (d) { console.error('diagnostics failed: ' + d); }
} finally {
  await context.close().catch(() => {});
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(userDataDir, { recursive: true, force: true });
  process.exit(exitCode);
}
