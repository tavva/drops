// ABOUTME: Starts a real Drops Fastify server for the spawned-CLI Playwright system test.
// ABOUTME: Runs in a child process so its exact loopback origins cannot leak into other specs.
import { buildServer } from '../../../src/server';
import { onAppHost, onDropHost } from '../../../src/middleware/host';
import { registerCsrf } from '../../../src/middleware/csrf';
import { registerRateLimit } from '../../../src/middleware/rateLimit';
import { registerAppHostRoutes } from '../../../src/routes/appHost';
import { dropServeRoute } from '../../../src/routes/content/dropServe';
import { config } from '../../../src/config';

const app = await buildServer();
await app.register(onAppHost(async (server) => {
  await registerRateLimit(server);
  await registerCsrf(server);
  await registerAppHostRoutes(server);
}));
await app.register(onDropHost(dropServeRoute));
await app.listen({ host: '127.0.0.1', port: config.PORT });
process.stdout.write('READY\n');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
}

process.once('SIGTERM', close);
process.once('SIGINT', close);
