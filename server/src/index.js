// @chpc/server — process entrypoint. Reads configuration from the environment,
// refuses unsafe combinations, then listens.
import { createApp } from './app.js';
import { pinProblem } from './auth.js';

const env = process.env;
const port = Number(env.PORT || 4100);
const host = env.HOST || '127.0.0.1';
const loopback = /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/.test(host);

const pin = env.CHPC_GUARDIAN_PIN || '';
const problem = pinProblem(pin);
if (problem) {
  if (loopback && !pin) {
    console.warn(`[chpc-server] WARNING: ${problem}. Because the server is bound to ${host} (this machine only), ` +
                 'the console is served WITHOUT a PIN. Set CHPC_GUARDIAN_PIN before exposing it to the network.');
  } else {
    console.error(`[chpc-server] refusing to start: ${problem}.`);
    console.error('[chpc-server] The console would be reachable from other devices without any authentication.');
    process.exit(1);
  }
}

const retentionDays = env.CHPC_RETENTION_DAYS === undefined ? 90 : Number(env.CHPC_RETENTION_DAYS);
if (!Number.isFinite(retentionDays) || retentionDays < 0) {
  console.error('[chpc-server] CHPC_RETENTION_DAYS must be a non-negative number of days (0 = keep forever)');
  process.exit(1);
}

const { app, purge } = createApp({
  dbFile: env.CHPC_DB,
  publicDir: env.CHPC_PUBLIC_DIR,
  guardianPin: pin || null,
  allowNoPin: loopback && !pin,
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
  console.log(`[chpc-server] guardian PIN: ${pin ? 'set' : 'NOT SET (loopback only)'} · usage retention: ${retentionDays || 'forever'} days`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[chpc-server] ${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
