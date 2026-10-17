import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { registerRoutes } from './routes.js';
import type { StripeGateway } from './stripe-gateway.js';

type RequestWithRaw = FastifyRequest & { rawBody?: Buffer };

export async function buildApp(options: {
  config: Config;
  pool: pg.Pool;
  stripe: StripeGateway;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_000_000,
    requestIdHeader: 'x-request-id',
  });

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    (request as RequestWithRaw).rawBody = buffer;
    if (buffer.length === 0) {
      done(null, {});
      return;
    }
    try {
      const parsed: unknown = JSON.parse(buffer.toString('utf8'));
      done(null, parsed);
    } catch {
      done(new AppError(400, 'invalid_json', 'Request body must be valid JSON'), undefined);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    const statusCode = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : 500;
    if (statusCode >= 400 && statusCode < 500) {
      const message = error instanceof Error ? error.message : 'Bad request';
      return reply.status(statusCode).send({ error: { code: 'bad_request', message } });
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'internal_error', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: 'not_found', message: `No route ${request.method} ${request.url}` } });
  });

  registerRoutes(app, { config: options.config, pool: options.pool, stripe: options.stripe });
  await app.ready();
  return app;
}
