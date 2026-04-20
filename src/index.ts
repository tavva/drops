// ABOUTME: Production entry point. Wires all route modules onto the correct host and starts the server.
import { buildServer } from './server';
import { config } from './config';
import { onAppHost, onContentHost, onDropHost } from './middleware/host';
import { registerCsrf } from './middleware/csrf';
import { registerAppSecurity, registerContentSecurity } from './middleware/security';
import { registerRateLimit } from './middleware/rateLimit';
import { loginRoute } from './routes/auth/login';
import { callbackRoute } from './routes/auth/callback';
import { chooseUsernameRoute } from './routes/auth/chooseUsername';
import { logoutRoute } from './routes/auth/logout';
import { bootstrapRoute } from './routes/auth/bootstrap';
import { dropBootstrapRoute } from './routes/auth/dropBootstrap';
import { dashboardRoute } from './routes/app/dashboard';
import { newDropRoute } from './routes/app/newDrop';
import { uploadRoute } from './routes/app/upload';
import { editDropRoute } from './routes/app/editDrop';
import { deleteDropRoute } from './routes/app/deleteDrop';
import { setPermissionsRoute } from './routes/app/setPermissions';
import { viewerRoutes } from './routes/app/viewers';
import { appStaticRoute } from './routes/app/static';
import { rootRoute } from './routes/app/root';
import { contentServeRoute } from './routes/content/serve';
import { dropServeRoute } from './routes/content/dropServe';
import { startOrphanSweep } from './services/scheduler';

const app = await buildServer();

await app.register(rootRoute);

await app.register(onAppHost(async (s) => {
  await registerAppSecurity(s);
  await registerRateLimit(s);
  await registerCsrf(s);
  await s.register(loginRoute);
  await s.register(callbackRoute);
  await s.register(chooseUsernameRoute);
  await s.register(dropBootstrapRoute);
  await s.register(logoutRoute);
  await s.register(dashboardRoute);
  await s.register(newDropRoute);
  await s.register(uploadRoute);
  await s.register(editDropRoute);
  await s.register(deleteDropRoute);
  await s.register(setPermissionsRoute);
  await s.register(viewerRoutes);
  await s.register(appStaticRoute);
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
