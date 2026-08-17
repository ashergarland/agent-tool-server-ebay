import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { badRequest } from '../../errors.js';
import type { AccountDeletionService } from './service.js';

/**
 * HTTP surface for eBay Marketplace Account Deletion/Closure compliance.
 *
 * This is deliberately thin: it moves values between Fastify and
 * {@link AccountDeletionService} and does nothing else. It is registered as an *encapsulated*
 * Fastify plugin so that the raw-body content-type parser it needs for signature verification
 * applies to this route alone and cannot change how `/tools` or `/mcp` parse their bodies.
 */

export const ACCOUNT_DELETION_ROUTE_PATH = '/ebay/notifications/marketplace-account-deletion';

/**
 * eBay's notification payload is a handful of short fields. Capping the callback well below the
 * server-wide limit keeps the unauthenticated attack surface small.
 */
const MAX_NOTIFICATION_BYTES = 32_768;

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The bytes as received, retained only for routes in the compliance plugin. eBay signs the
     * payload it transmitted, so re-serialising the parsed object would be verifying a different
     * document.
     */
    ebayRawBody?: Buffer;
  }
}

export interface AccountDeletionRoutesOptions {
  readonly service: AccountDeletionService;
}

/**
 * Registers the public callback.
 *
 * The route is intentionally **not** behind the connector API key: eBay calls it directly and has
 * no way to present one. Authenticity is established instead by the `x-ebay-signature` header,
 * which only eBay can produce, and the surface is limited to exactly two operations on one path —
 * it is not a general-purpose unauthenticated API. The route is likewise excluded from the
 * OpenAPI document and the MCP tool catalogue: it is infrastructure for eBay, not a capability
 * for an agent to call.
 */
export const accountDeletionRoutes = (
  app: FastifyInstance,
  options: AccountDeletionRoutesOptions,
  done: (error?: Error) => void,
): void => {
  const { service } = options;

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: MAX_NOTIFICATION_BYTES },
    (request: FastifyRequest, body: Buffer, next) => {
      request.ebayRawBody = body;
      if (body.length === 0) {
        next(badRequest('The notification body is empty.'), undefined);
        return;
      }
      try {
        next(null, JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        next(badRequest('The notification body is not valid JSON.'), undefined);
      }
    },
  );

  app.get(
    ACCOUNT_DELETION_ROUTE_PATH,
    (request: FastifyRequest<{ Querystring: Record<string, unknown> }>, reply: FastifyReply) => {
      const result = service.handleChallenge(request.query['challenge_code']);
      request.log.info(
        { event: 'ebay.account_deletion.challenge', outcome: 'answered' },
        'answered eBay endpoint validation challenge',
      );
      // Serialised by Fastify's JSON serialiser. eBay warns that hand-built response strings
      // often acquire a byte order mark, which makes the body invalid JSON and fails registration.
      return reply.code(200).type('application/json; charset=utf-8').send(result);
    },
  );

  app.post(
    ACCOUNT_DELETION_ROUTE_PATH,
    { bodyLimit: MAX_NOTIFICATION_BYTES },
    async (request: FastifyRequest<{ Body: unknown }>, reply: FastifyReply): Promise<void> => {
      const signatureHeader = request.headers['x-ebay-signature'];
      await service.handleNotification({
        rawBody: request.ebayRawBody ?? Buffer.alloc(0),
        parsedBody: request.body,
        signatureHeader: typeof signatureHeader === 'string' ? signatureHeader : undefined,
        logger: request.log,
      });
      // 204 is one of the acknowledgements eBay documents as successful, and it guarantees the
      // response carries nothing derived from the notification.
      await reply.code(204).send();
    },
  );

  done();
};
