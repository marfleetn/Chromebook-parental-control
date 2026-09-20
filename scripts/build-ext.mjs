#!/usr/bin/env node
/**
 * CHPC extension build — bundles @chpc/core into extension/vendor/core.js (ESM,
 * importable by the MV3 service worker) and sanity-checks the manifest.
 *
 *   node scripts/build-ext.mjs
 */
import { build } from 'esbuild';
import { readFileSync, existsSync } from 'node:fs';
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
  ...(manifest.web_accessible_resources || []).flatMap((w) => w.resources || []),
  'pages/blocked.js',
  'vendor/core.js',
]);
if (manifest.background?.type !== 'module') {
  console.error('manifest.background.type must be "module": background.js uses static imports');
  process.exit(1);
}
// MV3 forbids inline scripts in extension pages — catch them at build time.
for (const html of ['popup.html', 'pages/blocked.html']) {
  const src = readFileSync(path.join(ext, html), 'utf8');
  if (/<script(?![^>]*\ssrc=)[^>]*>[^<]*\S[^<]*<\/script>/i.test(src)) {
    console.error(`${html} contains an inline <script>; MV3 CSP blocks it`);
    process.exit(1);
  }
}
for (const f of files) {
  if (!f) continue;
  if (!existsSync(path.join(ext, f))) {
    console.error(`manifest references missing file: ${f}`);
    process.exit(1);
  }
}
console.log('extension build OK — vendor/core.js + manifest verified');
