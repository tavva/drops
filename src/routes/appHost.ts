// ABOUTME: Registers every app-host route module in one place so production and the
// ABOUTME: e2e server share identical route wiring. Host middleware stays with each caller.
import type { FastifyInstance } from 'fastify';
import { loginRoute } from './auth/login';
import { callbackRoute } from './auth/callback';
import { chooseUsernameRoute } from './auth/chooseUsername';
import { logoutRoute } from './auth/logout';
import { dropBootstrapRoute } from './auth/dropBootstrap';
import { magicRoutes } from './auth/magic';
import { dashboardRoute } from './app/dashboard';
import { newDropRoute } from './app/newDrop';
import { uploadRoute } from './app/upload';
import { editDropRoute } from './app/editDrop';
import { deleteDropRoute } from './app/deleteDrop';
import { setPermissionsRoute } from './app/setPermissions';
import { setEntryRoute } from './app/setEntry';
import { folderRoutes } from './app/folders';
import { viewerRoutes } from './app/viewers';
import { appStaticRoute } from './app/static';
import { rootRoute } from './app/root';
import { cliTokenRoutes } from './app/cliTokens';
import { cliDiscoveryRoute } from './cli/discovery';
import { cliAuthorizeRoutes } from './cli/authorize';
import { cliApiAuthRoutes } from './cli/apiAuth';
import { cliDeployRoute } from './cli/deploy';
import { cliListRoutes } from './cli/list';

export async function registerAppHostRoutes(s: FastifyInstance): Promise<void> {
  await s.register(rootRoute);
  await s.register(cliDiscoveryRoute);
  await s.register(cliAuthorizeRoutes);
  await s.register(cliApiAuthRoutes);
  await s.register(cliDeployRoute);
  await s.register(cliListRoutes);
  await s.register(loginRoute);
  await s.register(callbackRoute);
  await s.register(chooseUsernameRoute);
  await s.register(dropBootstrapRoute);
  await s.register(magicRoutes);
  await s.register(logoutRoute);
  await s.register(dashboardRoute);
  await s.register(cliTokenRoutes);
  await s.register(newDropRoute);
  await s.register(uploadRoute);
  await s.register(editDropRoute);
  await s.register(deleteDropRoute);
  await s.register(setPermissionsRoute);
  await s.register(setEntryRoute);
  await s.register(folderRoutes);
  await s.register(viewerRoutes);
  await s.register(appStaticRoute);
}
