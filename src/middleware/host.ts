// ABOUTME: Route registration helpers that constrain a plugin to the app or content host.
// ABOUTME: Requests whose host does not match are short-circuited to 404.
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

function hostScoped(kind: 'app' | 'content', plugin: FastifyPluginAsync): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.addHook('onRequest', async (req, reply) => {
      if (req.hostKind !== kind) reply.callNotFound();
    });
    await app.register(plugin);
  };
}

export function onAppHost(plugin: FastifyPluginAsync): FastifyPluginAsync {
  return hostScoped('app', plugin);
}

export function onContentHost(plugin: FastifyPluginAsync): FastifyPluginAsync {
  return hostScoped('content', plugin);
}

export { fp };
