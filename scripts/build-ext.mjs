#!/usr/bin/env node
/**
 * CHPC extension build — bundles @chpc/core into extension/vendor/core.js (ESM,
 * importable by the MV3 service worker) and sanity-checks the manifest.
 *
 *   node scripts/build-ext.mjs
 */
import { build, context } from 'esbuild';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ext = path.join(root, 'extension');

if (!existsSync(path.join(root, 'node_modules', 'esbuild'))) {
  console.error('esbuild not found — run `npm install` at the repo root first.');
  process.exit(1);
}

// 1) Vendor bundle: ESM format so background.js can `import('./vendor/core.js')`.
await build({
  entryPoints: [path.join(root, 'core/src/index.js')],
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: true,
  legalComments: 'none',
  outfile: path.join(ext, 'vendor/core.js'),
  logLevel: 'warning',
});

// 2) Manifest sanity: JSON parses, no dangling file references.
const manifest = JSON.parse(readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const files = new Set([
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  ...(manifest.action?.default_popup ? [manifest.action.default_popup.replace(/\.html?$/, '.js')] : []),
  'vendor/core.js',
]);
for (const f of files) {
  if (!f) continue;
  if (!existsSync(path.join(ext, f))) {
    console.error(`manifest references missing file: ${f}`);
    process.exit(1);
  }
}
console.log('extension build OK — vendor/core.js + manifest verified');
