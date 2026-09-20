// @chpc/server — entrypoint.
import { createApp } from './app.js';

const port = Number(process.env.PORT || 4100);
const host = process.env.HOST || '127.0.0.1';
const { app } = createApp({
  dbFile: process.env.CHPC_DB,
  publicDir: process.env.CHPC_PUBLIC_DIR,
});
app.listen(port, host, () => {
  console.log(`[chpc-server] listening on http://${host}:${port}`);
  console.log(`[chpc-server] tz default=${process.env.CHPC_TZ || 'Europe/London'}`);
});
