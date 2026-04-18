// ABOUTME: Production entry point. Builds the server and binds to the configured port.
import { buildServer } from './server';
import { config } from './config';

const app = await buildServer();
await app.listen({ host: '0.0.0.0', port: config.PORT });
