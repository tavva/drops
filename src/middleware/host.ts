// ABOUTME: Route registration helpers that scope a plugin to the app, content apex, or drop host.
// ABOUTME: Injects a host regex constraint on every child route so find-my-way never considers a route
// ABOUTME: outside its host — stops /:a/:b style apex routes from hijacking nested drop-host paths.
import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify';
import fp from 'fastify-plugin';
import { config } from '@/config';
import { contentRootDomain } from '@/lib/dropHost';

type ScopedHost = 'app' | 'content' | 'drop';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hostRegexFor(kind: ScopedHost): RegExp {
  const appHost = new URL(config.APP_ORIGIN).hostname.toLowerCase();
  const contentApex = contentRootDomain();
  const port = '(:\\d+)?';
  switch (kind) {
    case 'app':
      return new RegExp(`^${escapeRegex(appHost)}${port}$`, 'i');
    case 'content':
      return new RegExp(`^${escapeRegex(contentApex)}${port}$`, 'i');
    case 'drop': {
      const slug = '[a-z0-9][a-z0-9-]{0,30}[a-z0-9]';
      return new RegExp(`^${slug}--${slug}\\.${escapeRegex(contentApex)}${port}$`, 'i');
    }
  }
}

function hostScoped(kind: ScopedHost, plugin: FastifyPluginAsync): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    const constraint = hostRegexFor(kind);
    app.addHook('onRoute', (routeOpts: RouteOptions) => {
      const existing = (routeOpts.constraints ?? {}) as Record<string, unknown>;
      if (existing.host !== undefined) return;
      routeOpts.constraints = { ...existing, host: constraint };
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

export function onDropHost(plugin: FastifyPluginAsync): FastifyPluginAsync {
  return hostScoped('drop', plugin);
}

export { fp };
