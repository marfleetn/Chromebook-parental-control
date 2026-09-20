#!/usr/bin/env node
/**
 * Generate shields.io "endpoint" JSON for the README badges from real results:
 *   tests.json            — passing/failing count from `node --test`
 *   vulnerabilities.json  — `npm audit --omit=dev` total (runtime dependencies)
 *   vulnerabilities-dev.json — `npm audit` total (whole tree incl. dev toolchain)
 *   extension.json        — manifest version + minimum Chrome
 *
 * CI writes these to the `badges` branch; the README points shields.io at them.
 *   node scripts/badges.mjs [outDir]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const out = path.resolve(process.argv[2] || path.join(root, 'badges'));
fs.mkdirSync(out, { recursive: true });

const write = (name, label, message, color) => {
  fs.writeFileSync(path.join(out, name), JSON.stringify({ schemaVersion: 1, label, message, color }, null, 2) + '\n');
  console.log(`${name}: ${label} | ${message} (${color})`);
};

// ---- tests -----------------------------------------------------------------
const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap',
  ...fs.globSync ? fs.globSync(['core/test/*.mjs', 'core/test/*.js', 'server/test/*.js'], { cwd: root }) : []],
  { cwd: root, encoding: 'utf8' });
const tap = (t.stdout || '') + (t.stderr || '');
const pass = Number(/^# pass (\d+)/m.exec(tap)?.[1] ?? 0);
const fail = Number(/^# fail (\d+)/m.exec(tap)?.[1] ?? 0);
if (!pass && !fail) write('tests.json', 'tests', 'unknown', 'lightgrey');
else if (fail) write('tests.json', 'tests', `${fail} failing / ${pass + fail}`, 'red');
else write('tests.json', 'tests', `${pass} passing`, 'brightgreen');

// ---- vulnerabilities ---------------------------------------------------------
function auditTotal(args) {
  const r = spawnSync('npm', ['audit', '--json', ...args], { cwd: root, encoding: 'utf8' });
  try {
    const j = JSON.parse(r.stdout);
    const v = j.metadata?.vulnerabilities || {};
    return { total: Number(v.total ?? 0), high: Number(v.high ?? 0) + Number(v.critical ?? 0), ok: true };
  } catch {
    return { total: 0, high: 0, ok: false };
  }
}
for (const [file, label, args] of [
  ['vulnerabilities.json', 'vulnerabilities (runtime)', ['--omit=dev']],
  ['vulnerabilities-dev.json', 'vulnerabilities (all deps)', []],
]) {
  const a = auditTotal(args);
  if (!a.ok) write(file, label, 'audit unavailable', 'lightgrey');
  else if (a.total === 0) write(file, label, '0', 'brightgreen');
  else write(file, label, String(a.total), a.high ? 'red' : 'orange');
}

// ---- extension ---------------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
write('extension.json', 'extension', `v${manifest.version} · MV${manifest.manifest_version} · Chrome ≥ ${manifest.minimum_chrome_version}`, 'blue');

process.exit(fail ? 1 : 0);
