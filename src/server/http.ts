import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { AppError } from '../errors.js';
import { createMcpServer } from '../mcp/server.js';
import { buildOpenApiDocument } from '../openapi/document.js';
import type { Services } from '../services/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { createAuthenticator, type Principal } from './auth.js';
import { registerErrorHandler } from './errors.js';
import { FixedWindowRateLimiter, type RateLimitDecision } from './rate-limit.js';
import type { HttpServer } from './types.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface HttpServerDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
}

const MAX_BODY_BYTES = 1_000_000;

export const createHttpServer = (deps: HttpServerDeps): HttpServer => {
  const { config, logger, services, registry } = deps;
  const startedAt = Date.now();

  const app = Fastify({
    loggerInstance: logger,
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 && header.length <= 200
        ? header
        : randomUUID();
    },
    requestIdHeader: false,
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: true,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });

  const authenticator = createAuthenticator(config);
  const limiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max,
    config.http.rateLimit.windowMs,
  );
  /**
   * Applied before authentication so that an unauthenticated flood cannot force the connector to
   * perform an unbounded number of credential verifications. Deliberately more generous than the
   * per-principal limit, since a single caller may legitimately sit behind one address.
   */
  const preAuthLimiter = new FixedWindowRateLimiter(
    config.http.rateLimit.max > 0 ? config.http.rateLimit.max * 2 : 0,
    config.http.rateLimit.windowMs,
  );

  const rateLimitExceeded = (reply: FastifyReply, decision: RateLimitDecision): AppError => {
    void reply.header('retry-after', String(Math.ceil((decision.resetAtMs - Date.now()) / 1000)));
    return new AppError('rate_limited', 'Too many requests; slow down and retry.');
  };

  app.addHook('onSend', (request, reply, payload, done) => {
    void reply.header('x-request-id', request.id);
    void reply.header('cache-control', 'no-store');
    done(null, payload);
  });

  /** Authentication + rate limiting for every tool and MCP request. */
  // codeql[js/missing-rate-limiting]
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/tools') && !request.url.startsWith('/mcp')) return;

    const preAuth = preAuthLimiter.consume(`ip:${request.ip}`);
    if (!preAuth.allowed) throw rateLimitExceeded(reply, preAuth);

    const principal = await authenticator.authenticate(request);
    request.principal = principal;

    const decision = limiter.consume(principal.id);
    void reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (!decision.allowed) throw rateLimitExceeded(reply, decision);
  });

  registerErrorHandler(app);

  app.get('/health', () => ({
    status: 'ok' as const,
    service: config.service.name,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
  }));

  app.get('/version', () => ({
    service: config.service.name,
    version: config.service.version,
    gitSha: config.service.gitSha,
    node: process.version,
    environment: config.env,
    capabilities: {
      transports: ['stdio', 'streamable-http', 'openapi-http'],
      authMode: config.auth.mode,
      ebayEnvironment: config.ebay.environment,
      ebayConfigured: config.ebay.configured,
      defaultMarketplaceId: config.ebay.defaultMarketplaceId,
      searchMaxLimit: config.limits.searchMaxLimit,
      /**
       * The Browse API only exposes *active* listings. Sold and completed history requires the
       * limited-release Marketplace Insights API, which this connector does not use.
       */
      soldListingData: false,
    },
  }));

  const openApiDocument = buildOpenApiDocument(config, registry);
  app.get('/openapi.json', () => openApiDocument);

  app.get('/tools', () => ({
    tools: registry.list().map((tool) => ({
      name: tool.name,
      title: tool.title,
      summary: tool.summary,
      description: tool.description,
      kind: tool.kind,
      inputSchema: tool.inputJsonSchema,
      outputSchema: tool.outputJsonSchema,
    })),
  }));

  app.post<{ Params: { toolName: string }; Body: unknown }>('/tools/:toolName', async (request) => {
    const { toolName } = request.params;
    const principal = request.principal ?? { id: 'anonymous', kind: 'anonymous' as const };
    const tool = registry.get(toolName);
    const startedAtMs = Date.now();

    request.log.info(
      { event: 'tool.invoke', tool: toolName, kind: tool.kind, principal: principal.id },
      'tool invocation started',
    );

    const body = request.body;
    const input =
      body === undefined || body === null
        ? {}
        : typeof body === 'object' && 'input' in (body as Record<string, unknown>)
          ? (body as { input: unknown }).input
          : body;

    const result = await tool.invoke(input, services, {
      requestId: request.id,
      principal: principal.id,
    });

    request.log.info(
      {
        event: 'tool.result',
        tool: toolName,
        principal: principal.id,
        durationMs: Date.now() - startedAtMs,
      },
      'tool invocation succeeded',
    );

    return { tool: toolName, requestId: request.id, result };
  });

  const handleMcp = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ): Promise<void> => {
    const transport = new StreamableHTTPServerTransport();
    const server = createMcpServer(config, registry, services, {
      requestId: request.id,
      principal: request.principal?.id ?? 'anonymous',
    });
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await Promise.allSettled([transport.close(), server.close()]);
    };

    reply.raw.on('close', () => {
      void close();
    });

    try {
      await server.connect(transport as unknown as Transport);
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      await close();
      if (!reply.sent) throw error;
      request.log.error({ err: error, event: 'mcp.request.error' }, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader('content-type', 'application/json');
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      } else {
        reply.raw.destroy();
      }
    }
  };

  app.get('/mcp', handleMcp);
  app.post('/mcp', handleMcp);
  app.delete('/mcp', handleMcp);

  return app;
};
