import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import {
  ACCOUNT_DELETION_ROUTE_PATH,
  computeChallengeResponse,
  createAccountDeletionService,
} from '../../src/compliance/ebay-account-deletion/index.js';
import { testConfig } from '../helpers/config.js';
import { createFakeProvider, createTestLogger, makeListing } from '../helpers/fake-provider.js';
import {
  buildSignatureHeader,
  FakePublicKeyProvider,
  signPayload,
  validNotificationBody,
} from '../helpers/ebay-signature.js';

const API_KEY = 'test-api-key-that-is-long-enough-000000';
const ENDPOINT_URL = `https://connector.example.com${ACCOUNT_DELETION_ROUTE_PATH}`;
const VERIFICATION_TOKEN = 'example-compliance-verification-token-0001';

const complianceEnv = {
  AUTH_MODE: 'api-key',
  API_KEYS: API_KEY,
  EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT_URL,
  EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: VERIFICATION_TOKEN,
};

const buildApp = (
  overrides: Record<string, string | undefined> = {},
  publicKeys = new FakePublicKeyProvider(),
): Application => {
  const config = testConfig({ ...complianceEnv, ...overrides });
  return createApplication({
    config,
    logger: createTestLogger() as unknown as Logger,
    provider: createFakeProvider(),
    accountDeletion: createAccountDeletionService(config, { publicKeys }),
  });
};

describe('eBay marketplace account deletion callback', () => {
  let app: Application;

  beforeAll(async () => {
    app = buildApp();
    await app.http.ready();
  });

  afterAll(async () => {
    await app.http.close();
  });

  describe('GET endpoint validation challenge', () => {
    it('answers the challenge with the documented hash', async () => {
      const response = await app.http.inject({
        method: 'GET',
        url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=abc-123`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({
        challengeResponse: computeChallengeResponse({
          challengeCode: 'abc-123',
          verificationToken: VERIFICATION_TOKEN,
          endpointUrl: ENDPOINT_URL,
        }),
      });
    });

    it('returns a body that parses as JSON with no byte order mark', () => {
      return app.http
        .inject({ method: 'GET', url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=abc-123` })
        .then((response) => {
          expect(response.rawPayload[0]).toBe('{'.charCodeAt(0));
          expect(() => JSON.parse(response.body) as unknown).not.toThrow();
        });
    });

    it('requires no connector API key, because eBay cannot present one', async () => {
      const response = await app.http.inject({
        method: 'GET',
        url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=abc-123`,
      });
      expect(response.statusCode).toBe(200);
    });

    it('rejects a missing challenge code without revealing the verification token', async () => {
      const response = await app.http.inject({ method: 'GET', url: ACCOUNT_DELETION_ROUTE_PATH });

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain(VERIFICATION_TOKEN);
    });

    it('never includes the verification token in a successful response', async () => {
      const response = await app.http.inject({
        method: 'GET',
        url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=${VERIFICATION_TOKEN}`,
      });
      expect(response.body).not.toContain(VERIFICATION_TOKEN);
    });
  });

  describe('POST deletion notification', () => {
    const post = (
      body: unknown,
      headers: Record<string, string> = {},
      instance: Application = app,
    ) =>
      instance.http.inject({
        method: 'POST',
        url: ACCOUNT_DELETION_ROUTE_PATH,
        headers: { 'content-type': 'application/json', ...headers },
        payload: typeof body === 'string' ? body : JSON.stringify(body),
      });

    const signedFor = (body: unknown): Record<string, string> => ({
      'x-ebay-signature': buildSignatureHeader({
        signature: signPayload(Buffer.from(JSON.stringify(body), 'utf8')),
      }),
    });

    it('acknowledges a correctly signed notification with 204', async () => {
      const body = validNotificationBody();
      const response = await post(body, signedFor(body));

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });

    it('is idempotent across a redelivery of the same notification', async () => {
      const body = validNotificationBody();
      const headers = signedFor(body);

      const first = await post(body, headers);
      const second = await post(body, headers);

      expect(first.statusCode).toBe(204);
      expect(second.statusCode).toBe(204);
    });

    it('rejects an invalid signature with 412', async () => {
      const body = validNotificationBody();
      const response = await post(body, {
        'x-ebay-signature': buildSignatureHeader({ signature: signPayload('a different payload') }),
      });

      expect(response.statusCode).toBe(412);
      expect(response.json().error).toMatchObject({ code: 'precondition_failed' });
    });

    it('rejects a missing x-ebay-signature header with 400', async () => {
      const response = await post(validNotificationBody());
      expect(response.statusCode).toBe(400);
    });

    it('rejects a signed but structurally invalid payload with 400', async () => {
      const body = { metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' } };
      const response = await post(body, signedFor(body));

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toMatchObject({ code: 'bad_request' });
    });

    it('rejects a signed notification carrying a different topic', async () => {
      const body = validNotificationBody();
      (body['metadata'] as Record<string, unknown>)['topic'] = 'ITEM_SOLD';
      const response = await post(body, signedFor(body));

      expect(response.statusCode).toBe(400);
    });

    it('rejects a body that is not JSON', async () => {
      const response = await post('not json at all', {
        'x-ebay-signature': buildSignatureHeader({ signature: 'AAAA' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an empty body', async () => {
      const response = await post('', {
        'x-ebay-signature': buildSignatureHeader({ signature: 'AAAA' }),
      });
      expect(response.statusCode).toBe(400);
    });

    it('bounds the accepted body size well below the server-wide limit', async () => {
      const body = validNotificationBody();
      (body['notification'] as Record<string, unknown>)['padding'] = 'x'.repeat(40_000);
      const response = await post(body, signedFor(body));

      expect(response.statusCode).toBe(400);
    });

    it('maps a public-key lookup failure onto a bounded retryable error', async () => {
      const failing = new (class extends FakePublicKeyProvider {
        public override getPublicKey(): Promise<never> {
          return Promise.reject(new Error('eBay unreachable'));
        }
      })();
      const instance = buildApp({}, failing);
      await instance.http.ready();

      const body = validNotificationBody();
      const response = await post(body, signedFor(body), instance);

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('example_user');
      await instance.http.close();
    });

    it('never echoes account identifiers back to the caller', async () => {
      const body = validNotificationBody();
      const response = await post(body, {
        'x-ebay-signature': buildSignatureHeader({ signature: signPayload('mismatch') }),
      });

      expect(response.body).not.toContain('example_user');
      expect(response.body).not.toContain('example-user-id');
      expect(response.body).not.toContain('eiasToken');
    });
  });

  describe('isolation from the authenticated surface', () => {
    it('leaves /tools authentication intact', async () => {
      const unauthenticated = await app.http.inject({ method: 'GET', url: '/tools' });
      const authenticated = await app.http.inject({
        method: 'GET',
        url: '/tools',
        headers: { 'x-api-key': API_KEY },
      });

      expect(unauthenticated.statusCode).toBe(401);
      expect(authenticated.statusCode).toBe(200);
    });

    it('leaves /mcp authentication intact', async () => {
      const response = await app.http.inject({
        method: 'POST',
        url: '/mcp',
        payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      });
      expect(response.statusCode).toBe(401);
    });

    it('keeps percent-encoded protected routes protected', async () => {
      const toolResponse = await app.http.inject({
        method: 'POST',
        url: '/%74ools/ebay_get_listing',
        payload: { item: '407111131587' },
      });
      const mcpResponse = await app.http.inject({ method: 'POST', url: '/%6dcp', payload: {} });

      expect(toolResponse.statusCode).toBe(401);
      expect(mcpResponse.statusCode).toBe(401);
    });

    it('still parses authenticated tool bodies with the default JSON parser', async () => {
      const provider = createFakeProvider({ listing: makeListing() });
      const instance = createApplication({
        config: testConfig(complianceEnv),
        logger: createTestLogger() as unknown as Logger,
        provider,
        accountDeletion: createAccountDeletionService(testConfig(complianceEnv), {
          publicKeys: new FakePublicKeyProvider(),
        }),
      });
      await instance.http.ready();

      const response = await instance.http.inject({
        method: 'POST',
        url: '/tools/ebay_get_listing',
        headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
        payload: { item: '407111131587' },
      });

      expect(response.statusCode).toBe(200);
      await instance.http.close();
    });

    it('rate limits the public callback so it cannot amplify into eBay key lookups', async () => {
      const instance = buildApp({ RATE_LIMIT_MAX: '2' });
      await instance.http.ready();

      const call = () =>
        instance.http.inject({
          method: 'GET',
          url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=abc`,
        });

      // The pre-auth limiter is twice the configured per-principal limit.
      const codes: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        codes.push((await call()).statusCode);
      }

      expect(codes.slice(0, 4)).toEqual([200, 200, 200, 200]);
      expect(codes.at(-1)).toBe(429);
      await instance.http.close();
    });

    it('does not advertise the callback in the OpenAPI document', async () => {
      const response = await app.http.inject({ method: 'GET', url: '/openapi.json' });
      const document = response.json();

      expect(Object.keys(document.paths)).not.toContain(ACCOUNT_DELETION_ROUTE_PATH);
      expect(response.body).not.toContain(VERIFICATION_TOKEN);
    });

    it('reports the callback as configured without exposing its secret', async () => {
      const response = await app.http.inject({ method: 'GET', url: '/version' });

      expect(response.json()).toMatchObject({
        capabilities: { accountDeletionEndpointConfigured: true },
      });
      expect(response.body).not.toContain(VERIFICATION_TOKEN);
      expect(response.body).not.toContain(ENDPOINT_URL);
    });
  });

  describe('when the deployment is not configured for compliance', () => {
    it('does not mount the callback at all', async () => {
      const instance = createApplication({
        config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY }),
        logger: createTestLogger() as unknown as Logger,
        provider: createFakeProvider(),
      });
      await instance.http.ready();

      const challenge = await instance.http.inject({
        method: 'GET',
        url: `${ACCOUNT_DELETION_ROUTE_PATH}?challenge_code=abc`,
      });
      const version = await instance.http.inject({ method: 'GET', url: '/version' });

      expect(challenge.statusCode).toBe(404);
      expect(version.json()).toMatchObject({
        capabilities: { accountDeletionEndpointConfigured: false },
      });
      await instance.http.close();
    });
  });
});
