// Repository-level security and best-practice invariants.
//
// These tests read files, not code: the extension manifest, the deployment
// files, the CI workflows and the dependency manifests. They are tripwires —
// a pull request that widens a permission, adds a dependency, unpins an
// action or weakens the container must change a test here on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const list = (dir, re) => fs.readdirSync(path.join(root, dir)).filter((f) => re.test(f)).map((f) => path.join(dir, f));

// ---------------------------------------------------------------------------
// Chrome extension
// ---------------------------------------------------------------------------
test('HYG extension: manifest declares exactly the reviewed permission set and nothing more', () => {
  const m = json('extension/manifest.json');
  assert.equal(m.manifest_version, 3);
  assert.deepEqual([...m.permissions].sort(), ['alarms', 'declarativeNetRequest', 'idle', 'storage', 'tabs']);
  assert.deepEqual(m.host_permissions, ['<all_urls>'], 'broad host access is required to redirect any site; nothing else');
  assert.equal(m.optional_permissions, undefined);
  assert.equal(m.content_scripts, undefined, 'no content scripts: the extension never runs inside pages');
  assert.equal(m.content_security_policy, undefined, 'MV3 default CSP (no remote or inline scripts) is kept');
  assert.equal(m.background.type, 'module');
  assert.deepEqual(m.web_accessible_resources, [{ resources: ['pages/blocked.html'], matches: ['http://*/*', 'https://*/*'] }]);
  for (const forbidden of ['webRequest', 'webRequestBlocking', 'scripting', 'cookies', 'history', 'nativeMessaging', 'debugger', 'management', 'proxy', 'privacy', 'downloads', 'clipboardRead', 'geolocation']) {
    assert.ok(!m.permissions.includes(forbidden), forbidden);
  }
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.name.length <= 75 && m.description.length <= 132, 'store length limits');
  assert.ok(Number(m.minimum_chrome_version) >= 116);
});

test('HYG extension: no phone-home — no hard-coded network endpoints in extension code', () => {
  const files = [...list('extension', /\.js$/), ...list('extension/pages', /\.js$/)].filter((f) => !f.includes('vendor'));
  for (const f of files) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const urls = [...src.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    assert.deepEqual(urls, [], `${f} contains literal URLs: ${urls.join(', ')} (the console address must come from pairing)`);
    assert.ok(!/\beval\(|new Function\(|importScripts\(/.test(src), `${f} uses dynamic code execution`);
    assert.ok(!/fetch\(\s*['"`]/.test(src), `${f} fetches a hard-coded address`);
  }
});

test('HYG extension: no inline scripts or inline handlers in extension pages', () => {
  for (const f of ['extension/popup.html', 'extension/pages/blocked.html']) {
    const html = read(f);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[^<]*\S[^<]*<\/script>/i.test(html), f + ': inline <script>');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), f + ': inline event handler');
    assert.ok(!/javascript:/i.test(html), f + ': javascript: URL');
    for (const m of html.matchAll(/<script[^>]*src="([^"]+)"/g)) assert.ok(!/^https?:/.test(m[1]), f + ' loads a remote script');
  }
});

test('HYG extension: the committed vendor bundle is the current core build', async () => {
  const { spawnSync } = await import('node:child_process');
  const before = read('extension/vendor/core.js');
  const r = spawnSync(process.execPath, ['scripts/build-ext.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(read('extension/vendor/core.js'), before, 'extension/vendor/core.js is stale: run npm run build:ext and commit it');
});

// ---------------------------------------------------------------------------
// Dependencies and supply chain
// ---------------------------------------------------------------------------
test('HYG deps: runtime dependency surface is exactly what the security report reviewed', () => {
  assert.deepEqual(Object.keys(json('server/package.json').dependencies).sort(), ['@chpc/core', 'express']);
  assert.deepEqual(Object.keys(json('core/package.json').dependencies || {}), [], 'core has zero dependencies');
  assert.deepEqual(Object.keys(json('web/package.json').dependencies).sort(), ['react', 'react-dom']);
  assert.equal(json('package.json').dependencies, undefined, 'no runtime deps at the root');
  // Adding a dependency is a deliberate decision: update this test and docs/SECURITY-REPORT.md together.
});

test('HYG deps: lockfile present, pinned, and no install-time scripts from dependencies', () => {
  const lock = json('package-lock.json');
  assert.equal(lock.lockfileVersion >= 3, true);
  const pkgs = Object.entries(lock.packages).filter(([k]) => k.startsWith('node_modules/'));
  assert.ok(pkgs.length > 50);
  for (const [k, v] of pkgs) {
    if (v.link) continue;
    assert.ok(v.resolved && v.integrity, `${k} lacks resolved/integrity`);
    assert.match(v.resolved, /^https:\/\/registry\.npmjs\.org\//, `${k} resolves outside the npm registry`);
    // esbuild's install script only verifies its own binary; fsevents is a macOS-only optional dependency of the dev server.
    if (v.hasInstallScript) assert.ok(v.optional || /(^|\/)node_modules\/(esbuild|@esbuild\/[^/]+)$/.test(k), `${k} runs an install script`);
  }
  for (const [name, spec] of Object.entries({ ...json('package.json').devDependencies, ...json('server/package.json').dependencies, ...json('web/package.json').dependencies })) {
    assert.ok(/^(\^|~)?\d|^\*$/.test(spec), `${name} uses a non-registry or git spec: ${spec}`);
  }
});

test('HYG deps: no secrets or private keys committed', () => {
  const suspicious = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk_live_[A-Za-z0-9]{10,})/;
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (['node_modules', '.git', 'dist', 'e2e-artifacts'].includes(d.name)) return [];
    return d.isDirectory() ? walk(p) : [p];
  });
  for (const f of walk('.')) {
    if (/\.(png|jpg|ico|woff2?|lock)$/.test(f)) continue;
    assert.ok(!suspicious.test(read(f)), f + ' looks like it contains a credential');
  }
  const env = read('.env.example');
  assert.match(env, /^CHPC_GUARDIAN_PIN=\s*$/m, '.env.example ships without a PIN value');
});

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------
test('HYG docker: image and compose follow least privilege', () => {
  const df = read('Dockerfile');
  assert.match(df, /^USER chpc$/m, 'runs as a non-root user');
  assert.match(df, /npm ci --omit=dev/, 'runtime image has no dev dependencies');
  assert.ok(!/:latest/.test(df), 'no :latest base images');
  assert.match(df, /^FROM node:\d+-alpine/m);
  assert.match(df, /HEALTHCHECK/);
  assert.ok(!/CHPC_GUARDIAN_PIN=\S/.test(df), 'no PIN baked into the image');
  const compose = read('docker-compose.yml');
  for (const must of ['read_only: true', 'no-new-privileges:true', 'cap_drop:', '- ALL', 'restart: unless-stopped']) assert.ok(compose.includes(must), 'compose lacks ' + must);
  for (const never of ['privileged: true', 'network_mode: host', '/var/run/docker.sock', 'CHPC_ALLOW_NO_PIN']) assert.ok(!compose.includes(never), 'compose contains ' + never);
  assert.match(compose, /image: ghcr\.io\/marfleetn\/chromebook-parental-control:/);
});

test('HYG installer: service unit is hardened and the data directory is private', () => {
  const sh = read('install.sh');
  for (const must of ['set -euo pipefail', 'NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'User=chpc', 'chmod 700', 'chmod 600']) {
    assert.ok(sh.includes(must), 'install.sh lacks ' + must);
  }
  assert.ok(!/curl[^\n]*\|\s*(sudo\s+)?sh\b/.test(sh.replace(/^#.*$/gm, '')), 'installer does not pipe further downloads into a shell');
});

// ---------------------------------------------------------------------------
// CI / GitHub configuration
// ---------------------------------------------------------------------------
test('HYG workflows: least-privilege permissions and SHA-pinned actions', () => {
  const files = list('.github/workflows', /\.ya?ml$/);
  assert.ok(files.length >= 4);
  for (const f of files) {
    const y = read(f);
    assert.match(y, /^permissions:/m, f + ' must declare top-level permissions');
    assert.ok(!/permissions:\s*write-all/.test(y), f + ' grants write-all');
    for (const m of y.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
      const [, action, ref] = m;
      if (action.startsWith('./')) continue;
      assert.match(ref, /^[0-9a-f]{40}$/, `${f}: ${action}@${ref} is not pinned to a commit SHA`);
    }
    assert.ok(!/pull_request_target/.test(y), f + ' uses pull_request_target (secrets exposed to forks)');
    assert.ok(!/\$\{\{\s*github\.event\.(issue|comment|pull_request)\.(title|body)/.test(y), f + ' interpolates untrusted event text into a script');
  }
  const db = read('.github/dependabot.yml');
  for (const eco of ['npm', 'github-actions', 'docker']) assert.ok(db.includes(`package-ecosystem: ${eco}`), 'dependabot covers ' + eco);
});

test('HYG repo: security policy, licence and PR template exist and say the right things', () => {
  assert.match(read('SECURITY.md'), /Reporting a vulnerability/i);
  assert.match(read('LICENSE'), /MIT/);
  assert.match(read('.github/pull_request_template.md'), /Security checklist/);
  assert.match(read('README.md'), /Known limits/);
  const gi = read('.gitignore');
  for (const must of ['.env', 'node_modules', 'data/']) assert.ok(gi.includes(must), '.gitignore lacks ' + must);
});
