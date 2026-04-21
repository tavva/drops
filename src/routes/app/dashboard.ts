// ABOUTME: GET /app dashboard page — shows the folder tree with per-viewer visibility.
import type { FastifyPluginAsync } from 'fastify';
import { requireCompletedMember } from '@/middleware/auth';
import { renderDashboard } from '@/routes/app/dashboardView';

export const dashboardRoute: FastifyPluginAsync = async (app) => {
  app.get('/app', { preHandler: requireCompletedMember }, async (req, reply) => {
    return renderDashboard(req, reply);
  });
};
