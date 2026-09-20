#!/usr/bin/env node
/**
 * Console smoke test in a real Chromium (Playwright): PIN gate, wrong/right PIN,
 * add a child, save a policy, generate a pairing code, usage tab, lock.
 * Requires `npm run build:web` first and Playwright (see e2e-extension.mjs).
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PIN = 'e2e-pin-2026';
let playwright;
try { playwright = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
catch { console.error('playwright not found — install it or set PLAYWRIGHT_MODULE'); process.exit(2); }
if (!fs.existsSync(path.join(root, 'web/dist/index.html'))) { console.error('run `npm run build:web` first'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (cond, msg) => { if (!cond) throw new Error('E2E FAIL: ' + msg); console.log('  ok  ' + msg); };

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chpc-e2e-web-'));
const port = 4700 + Math.floor(Math.random() * 300);
const base = `http://127.0.0.1:${port}`;
// No PIN in the environment: the server must print a setup code and the console must offer first-run setup.
const server = spawn(process.execPath, ['server/src/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', CHPC_GUARDIAN_PIN: '', CHPC_ALLOW_NO_PIN: '', CHPC_DB: path.join(dataDir, 'chpc.db'), CHPC_PUBLIC_DIR: path.join(root, 'web/dist') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '';
server.stdout.on('data', (d) => { stdout += d; });
for (let i = 0; i < 50; i++) { try { if ((await fetch(base + '/api/health')).ok) break; } catch {} await sleep(100); }
await sleep(300);
const setupCode = (/Setup code:\s+([A-Z]{4}-[A-Z]{4})/.exec(stdout) || [])[1];
check(!!setupCode, 'server printed a one-time setup code: ' + setupCode);
check(fs.readFileSync(path.join(dataDir, 'setup-code.txt'), 'utf8').trim() === setupCode.replace('-', ''), 'setup code also written next to the database');

const browser = await playwright.chromium.launch({ headless: true });
let exitCode = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 401s (PIN gate, deliberate wrong PIN) and 503s (setup-required probe) are expected responses.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|503)/.test(m.text())) errors.push(m.text()); });

  await page.goto(base + '/');
  await page.waitForSelector('#setup-code');
  check(true, 'first-run setup screen shown when no PIN exists');
  await page.fill('#setup-code', 'zzzz-zzzz');
  await page.fill('#new-pin', PIN);
  await page.fill('#new-pin2', PIN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.banner.error');
  check(/setup code is not right/.test(await page.textContent('.banner.error')), 'wrong setup code is rejected');
  await page.fill('#setup-code', setupCode.toLowerCase());
  await page.click('button[type=submit]');
  await page.waitForSelector('text=The kids');
  check(true, 'correct setup code + new PIN opens the console');
  check(!fs.existsSync(path.join(dataDir, 'setup-code.txt')), 'setup code file removed once the PIN is set');
  const st = await fetch(base + '/api/setup/status').then((r) => r.json());
  check(st.needsSetup === false && st.pinSource === 'db', 'server reports setup complete');
  await page.click('.topbar button:has-text("Lock")');
  await page.waitForSelector('#pin');
  check(true, 'PIN gate shown after locking');
  await page.fill('#pin', 'wrong-pin');
  await page.click('button[type=submit]');
  await page.waitForSelector('.banner.error');
  check(/Wrong PIN/.test(await page.textContent('.banner.error')), 'wrong PIN is rejected with a message');
  await page.fill('#pin', PIN);
  await page.click('button[type=submit]');
  await page.waitForSelector('text=The kids');
  check(true, 'correct PIN unlocks the dashboard');

  await page.fill('input[placeholder="New child name…"]', 'Maya');
  await page.click('button:has-text("Add child")');
  await page.waitForURL(/#\/kid\/\d+/);
  await page.waitForSelector('h1:has-text("Maya")');
  check(true, 'child created and opened');

  // Policy: block a site, set a daily limit, save.
  await page.waitForSelector('text=Save policy');
  await page.fill('input[placeholder*="youtube.com"] >> nth=0', 'tiktok.com');
  await page.keyboard.press('Enter');
  await page.fill('input[placeholder="e.g. 90"]', '90');
  await page.click('button:has-text("Save policy")');
  await page.waitForSelector('.pill.ok:has-text("saved")');
  const pol = await fetch(`${base}/api/kids/1/policy`, { headers: { 'x-guardian-pin': PIN } }).then((r) => r.json());
  check(Array.isArray(pol.policy.deny) && pol.policy.deny.some((d) => d === 'tiktok.com') && pol.policy.dailyMinutes === 90, 'policy saved through the UI reached the API');

  // Devices: generate a code.
  await page.click('.tab:has-text("Devices")');
  await page.fill('input[placeholder^="Device name"]', "Maya's Chromebook");
  await page.click('button:has-text("Generate code")');
  await page.waitForSelector('.code-box');
  check(/[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}/.test(await page.textContent('.code-box')), 'pairing code displayed');
  await page.waitForSelector('text=Maya\'s Chromebook');
  check(true, 'paired device listed with its label');
  await page.fill('input[placeholder="e.g. www.youtube.com"]', 'www.tiktok.com');
  await page.click('button:has-text("Check")');
  await page.waitForSelector('pre:has-text("BLOCKED")');
  check(true, 'test-a-decision shows BLOCKED for a denied site');

  // Usage tab renders without errors.
  await page.click('.tab:has-text("Usage")');
  await page.waitForSelector('text=Last 7 days');
  check(true, 'usage tab renders');

  // Settings drawer + lock.
  await page.click('.topbar button:has-text("Settings")');
  await page.waitForSelector('.drawer');
  check(/90 days/.test(await page.textContent('.drawer')), 'settings drawer shows retention');
  await page.click('.drawer button:has-text("Close")');
  await page.click('.topbar button:has-text("Lock")');
  await page.waitForSelector('#pin');
  check(true, 'Lock returns to the PIN gate');

  check(errors.length === 0, 'no console/page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  console.log('\nCONSOLE E2E PASS');
} catch (e) {
  exitCode = 1;
  console.error('\n' + (e && e.stack || e));
} finally {
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(exitCode);
}
