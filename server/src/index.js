// @chpc/server — process entrypoint. Reads configuration from the environment,
// refuses unsafe combinations, then listens.
import path from 'node:path';
import { createApp } from './app.js';
import { pinProblem } from './auth.js';
import { formatCode } from './db.js';

const env = process.env;
const port = Number(env.PORT || 4100);
const host = env.HOST || '127.0.0.1';
const loopback = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/.test(host);
const dbFile = env.CHPC_DB || path.join(process.cwd(), 'data', 'chpc.db');

// PIN source 1: the environment (advanced installs). Must be strong if set.
const envPin = env.CHPC_GUARDIAN_PIN || '';
if (envPin) {
  const problem = pinProblem(envPin);
  if (problem) {
    console.error(`[chpc-server] refusing to start: CHPC_GUARDIAN_PIN — ${problem}.`);
    process.exit(1);
  }
}
// Dev convenience: explicit opt-in, loopback only. Never implicit.
const allowNoPin = !envPin && /^(1|true)$/i.test(env.CHPC_ALLOW_NO_PIN || '');
if (allowNoPin && !loopback) {
  console.error('[chpc-server] refusing to start: CHPC_ALLOW_NO_PIN is only honoured when HOST is a loopback address.');
  process.exit(1);
}

const retentionDays = env.CHPC_RETENTION_DAYS === undefined ? 90 : Number(env.CHPC_RETENTION_DAYS);
if (!Number.isFinite(retentionDays) || retentionDays < 0) {
  console.error('[chpc-server] CHPC_RETENTION_DAYS must be a non-negative number of days (0 = keep forever)');
  process.exit(1);
}

const { app, purge, getSetupCode } = createApp({
  dbFile,
  publicDir: env.CHPC_PUBLIC_DIR,
  guardianPin: envPin || null,
  allowNoPin,
  setupCodeFile: path.join(path.dirname(dbFile), 'setup-code.txt'),
  corsOrigins: (env.CHPC_CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  trustProxy: env.CHPC_TRUST_PROXY === '1' || env.CHPC_TRUST_PROXY === 'true' ? 1 : false,
  retentionDays,
});

// Usage retention: purge at startup (createApp does it) and every 6 hours.
if (retentionDays > 0) {
  const t = setInterval(() => {
    try {
      const n = purge();
      if (n) console.log(`[chpc-server] retention: removed ${n} usage rows older than ${retentionDays} days`);
    } catch (e) { console.error('[chpc-server] retention purge failed', e); }
  }, 6 * 60 * 60 * 1000);
  t.unref();
}

const server = app.listen(port, host, () => {
  console.log(`[chpc-server] listening on http://${host}:${port}`);
  console.log(`[chpc-server] usage retention: ${retentionDays || 'forever'} days · database: ${dbFile}`);
  const code = getSetupCode();
  if (code) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────────────────────┐');
    console.log('  │  FIRST-RUN SETUP                                             │');
    console.log('  │  Open the console in a browser and choose your guardian PIN. │');
    console.log(`  │  Setup code:  ${formatCode(code)}                                    │`);
    console.log('  │  (also in setup-code.txt next to the database; single use)   │');
    console.log('  └──────────────────────────────────────────────────────────────┘');
    console.log('');
  } else if (allowNoPin) {
    console.warn('[chpc-server] WARNING: CHPC_ALLOW_NO_PIN is set — the console runs WITHOUT a PIN on this machine only.');
  } else {
    console.log(`[chpc-server] guardian PIN: ${envPin ? 'set by CHPC_GUARDIAN_PIN' : 'stored (change it in the console)'}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[chpc-server] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
