// ABOUTME: Production entry point. Wires all route modules onto the correct host and starts the server.
import { buildServer } from './server';
import { config } from './config';
import { onAppHost, onContentHost, onDropHost } from './middleware/host';
import { registerCsrf } from './middleware/csrf';
import { registerAppSecurity, registerContentSecurity } from './middleware/security';
import { registerRateLimit } from './middleware/rateLimit';
import { bootstrapRoute } from './routes/auth/bootstrap';
import { registerAppHostRoutes } from './routes/appHost';
import { contentServeRoute } from './routes/content/serve';
import { dropServeRoute } from './routes/content/dropServe';
import { startOrphanSweep } from './services/scheduler';

const app = await buildServer();

await app.register(onAppHost(async (s) => {
  await registerAppSecurity(s);
  await registerRateLimit(s);
  await registerCsrf(s);
  await registerAppHostRoutes(s);
}));

await app.register(onContentHost(async (s) => {
  await registerContentSecurity(s);
  await s.register(contentServeRoute);
}));

await app.register(onDropHost(async (s) => {
  await registerContentSecurity(s);
  await registerRateLimit(s);
  await s.register(bootstrapRoute);
  await s.register(dropServeRoute);
}));

startOrphanSweep();

await app.listen({ host: '0.0.0.0', port: config.PORT });
