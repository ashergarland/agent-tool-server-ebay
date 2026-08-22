import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'pino';
import { createApplication, type Application } from '../../src/app.js';
import { ItemGroupError } from '../../src/errors.js';
import { EbayShortLinkResolver } from '../../src/provider/ebay/short-links.js';
import type { FetchLike } from '../../src/provider/ebay/oauth.js';
import { testConfig } from '../helpers/config.js';
import {
  createFakeProvider,
  createTestLogger,
  makeListing,
  makeSummary,
  GROUP_ID,
} from '../helpers/fake-provider.js';

const API_KEY = 'test-api-key-that-is-long-enough-000000';

const buildApp = (
  overrides: Record<string, string | undefined> = {},
  provider = createFakeProvider(),
): Application =>
  createApplication({
    config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY, ...overrides }),
    logger: createTestLogger() as unknown as Logger,
    provider,
  });

describe('HTTP surface', () => {
  let app: Application;

  beforeAll(async () => {
    app = buildApp();
    await app.http.ready();
  });

  afterAll(async () => {
    await app.http.close();
  });

  const auth = { authorization: ['Bearer', API_KEY].join(' ') };

  it('serves an unauthenticated health probe', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', service: 'agent-tool-server-ebay' });
  });

  it('serves version and capability metadata without auth', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/version' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: '1.2.3',
      capabilities: {
        transports: ['stdio', 'streamable-http', 'openapi-http'],
        authMode: 'api-key',
        ebayEnvironment: 'production',
        ebayConfigured: true,
        defaultMarketplaceId: 'EBAY_US',
        soldListingData: false,
      },
    });
  });

  it('echoes a request id on every response', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'trace-me' },
    });
    expect(response.headers['x-request-id']).toBe('trace-me');
  });

  it('rejects unauthenticated tool calls', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/tools' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toMatchObject({ code: 'unauthorized', retryable: false });
  });

  it('cannot bypass protected-route authentication with percent-encoded paths', async () => {
    const toolResponse = await app.http.inject({
      method: 'POST',
      url: '/%74ools/ebay_get_listing',
      payload: { item: '407111131587' },
    });
    const mcpResponse = await app.http.inject({
      method: 'POST',
      url: '/%6dcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'encoded-path-test', version: '1.0.0' },
        },
      },
    });

    expect(toolResponse.statusCode).toBe(401);
    expect(mcpResponse.statusCode).toBe(401);
  });

  it('rejects an incorrect api key', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { authorization: ['Bearer', 'wrong-key-wrong-key-wrong-key-wrong'].join(' ') },
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a key that is a prefix of the real one', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': API_KEY.slice(0, -1) },
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the x-api-key header', async () => {
    const response = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': API_KEY },
    });
    expect(response.statusCode).toBe(200);
  });

  it('lists tools with their schemas', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/tools', headers: auth });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tools).toHaveLength(5);
    expect(body.tools[0]).toHaveProperty('inputSchema.type', 'object');
    expect(body.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'ebay_get_listing',
      'ebay_get_item_group',
      'ebay_search_listings',
      'ebay_find_similar_listings',
      'ebay_compare_listings',
    ]);
  });

  it('retrieves a listing from a pasted eBay URL', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: 'https://www.ebay.com/itm/Sony-PS2-Slim/407111131587?hash=abc' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ tool: 'ebay_get_listing' });
    expect(body.result.listing).toMatchObject({
      legacyItemId: '407111131587',
      active: true,
      estimatedDeliveredTotal: { value: 102.49, currency: 'USD' },
    });
  });

  it('never forwards inbound connector credentials while resolving a mobile share link', async () => {
    let outboundUrl: string | undefined;
    let outboundInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (url, init) => {
      outboundUrl = url;
      outboundInit = init;
      return Promise.resolve(
        new Response('', {
          status: 301,
          headers: { location: 'https://www.ebay.com/itm/168601131927?mkevt=1&mkcid=16' },
        }),
      );
    };
    const isolated = createApplication({
      config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY }),
      logger: createTestLogger() as unknown as Logger,
      provider: createFakeProvider(),
      itemReferenceResolver: new EbayShortLinkResolver({ fetchImpl }),
    });
    await isolated.http.ready();

    try {
      const response = await isolated.http.inject({
        method: 'POST',
        url: '/tools/ebay_get_listing',
        headers: {
          ...auth,
          'x-api-key': API_KEY,
          cookie: 'caller-session=must-not-leave-the-connector',
        },
        payload: { item: 'https://ebay.io/m/tPMNkN' },
      });

      expect(response.statusCode).toBe(200);
      expect(outboundUrl).toBe('https://ebay.io/m/tPMNkN');
      expect(outboundInit?.credentials).toBe('omit');
      expect(outboundInit?.redirect).toBe('manual');
      const outboundHeaders = new Headers(outboundInit?.headers);
      expect(outboundHeaders.has('authorization')).toBe(false);
      expect(outboundHeaders.has('x-api-key')).toBe(false);
      expect(outboundHeaders.has('cookie')).toBe(false);
      expect(JSON.stringify(outboundInit)).not.toContain(API_KEY);
      expect(JSON.stringify(outboundInit)).not.toContain('must-not-leave-the-connector');
    } finally {
      await isolated.http.close();
    }
  });

  it('accepts both a bare payload and an { input } envelope', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_search_listings',
      headers: auth,
      payload: { input: { query: 'sega saturn console' } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.listings).toHaveLength(1);
  });

  it('returns 400 with validation issues for bad input', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: 12345 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.issues[0].path).toBe('item');
  });

  it('returns 400 for an unparseable eBay reference', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: 'https://www.amazon.com/dp/B00005N5PF' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('bad_request');
  });

  it('returns 404 for an unknown tool', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_does_not_exist',
      headers: auth,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('not_found');
  });

  it('serves an OpenAPI document covering every tool', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/openapi.json' });
    expect(response.statusCode).toBe(200);

    const document = response.json();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info.title).toBe('eBay Marketplace');
    expect(document.info.description).toMatch(/active listings only/);
    for (const tool of app.registry.list()) {
      expect(document.paths[`/tools/${tool.name}`]).toBeDefined();
      expect(document.paths[`/tools/${tool.name}`].post['x-openai-isConsequential']).toBe(false);
      expect(document.paths[`/tools/${tool.name}`].post.operationId).toBe(tool.name);
    }
  });

  it('returns 404 in the standard error envelope for unknown routes', async () => {
    const response = await app.http.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'not_found' });
  });
});

describe('upstream error normalisation', () => {
  it('maps an eBay not_found to a 404 envelope', async () => {
    const { AppError } = await import('../../src/errors.js');
    const provider = createFakeProvider();
    const failing = {
      ...provider,
      getListing: () =>
        Promise.reject(new AppError('not_found', 'getListing: The item was not found.')),
    };
    const app = buildApp({}, failing);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: { authorization: ['Bearer', API_KEY].join(' ') },
      payload: { item: '407111131587' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toMatchObject({ code: 'not_found', retryable: false });
    await app.http.close();
  });

  it('maps an eBay throttle to a retryable 429 envelope', async () => {
    const { AppError } = await import('../../src/errors.js');
    const provider = createFakeProvider();
    const failing = {
      ...provider,
      searchListings: () =>
        Promise.reject(
          new AppError('rate_limited', 'searchListings: eBay throttled the request', {
            retryable: true,
          }),
        ),
    };
    const app = buildApp({}, failing);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_search_listings',
      headers: { authorization: ['Bearer', API_KEY].join(' ') },
      payload: { query: 'ps2' },
    });

    expect(response.statusCode).toBe(429);
    expect(response.json().error).toMatchObject({ code: 'rate_limited', retryable: true });
    await app.http.close();
  });

  it('maps an unexpected provider failure to a 500 envelope', async () => {
    const provider = createFakeProvider();
    const failing = {
      ...provider,
      getListing: () => Promise.reject(new Error('unexpected boom')),
    };
    const app = buildApp({}, failing);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: { authorization: ['Bearer', API_KEY].join(' ') },
      payload: { item: '407111131587' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({ code: 'internal_error' });
    await app.http.close();
  });

  it('does not leak internal error messages in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const provider = createFakeProvider();
    const failing = {
      ...provider,
      getListing: () => Promise.reject(new Error('connection string: super-secret')),
    };
    const app = buildApp({}, failing);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: { authorization: ['Bearer', API_KEY].join(' ') },
      payload: { item: '407111131587' },
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.stringify(response.json())).not.toContain('super-secret');
    await app.http.close();
    vi.unstubAllEnvs();
  });
});

describe('ended listings', () => {
  it('reports an ended listing as inactive rather than failing', async () => {
    const provider = createFakeProvider({
      listing: makeListing({
        active: false,
        ended: true,
        secondsRemaining: -120,
        itemEndDate: '2020-01-01T00:00:00.000Z',
      }),
    });
    const app = buildApp({}, provider);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: { authorization: ['Bearer', API_KEY].join(' ') },
      payload: { item: '407111131587' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.listing).toMatchObject({ active: false, ended: true });
    await app.http.close();
  });
});

describe('search to detail handoff', () => {
  const auth = { authorization: ['Bearer', API_KEY].join(' ') };

  /**
   * The production regression: search succeeded, but feeding the first row's identifier to
   * ebay_get_listing failed with eBay error 11006. The identifier a search returns must be usable
   * with the matching detail tool, unchanged.
   */
  it('passes a returned RESTful itemId straight to getItem', async () => {
    const provider = createFakeProvider({
      search: { listings: [makeSummary({ itemId: 'v1|407111131587|0' })] },
    });
    const app = buildApp({}, provider);
    await app.http.ready();

    const search = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_search_listings',
      headers: auth,
      payload: { query: 'nintendo 64 console' },
    });
    expect(search.statusCode).toBe(200);
    const first = search.json().result.listings[0] as { itemId: string };

    const detail = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: first.itemId },
    });

    expect(detail.statusCode).toBe(200);
    expect(detail.json().result).toMatchObject({ kind: 'listing' });
    const call = provider.calls.find((entry) => entry.name === 'getListing');
    expect(call?.args[0]).toEqual({ marketplaceId: 'EBAY_US', itemId: 'v1|407111131587|0' });
    await app.http.close();
  });

  it('carries item group metadata through search and into ebay_get_item_group', async () => {
    const provider = createFakeProvider({
      search: {
        listings: [
          makeSummary({
            itemId: `v1|${GROUP_ID}|623456789012`,
            legacyItemId: GROUP_ID,
            itemGroupId: GROUP_ID,
            itemGroupType: 'SELLER_DEFINED_VARIATIONS',
          }),
        ],
      },
    });
    const app = buildApp({}, provider);
    await app.http.ready();

    const search = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_search_listings',
      headers: auth,
      payload: { query: 'nintendo 64 console' },
    });
    const row = search.json().result.listings[0] as { itemGroupId: string; itemGroupType: string };
    expect(row.itemGroupType).toBe('SELLER_DEFINED_VARIATIONS');

    const group = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_item_group',
      headers: auth,
      payload: { itemGroup: row.itemGroupId },
    });

    expect(group.statusCode).toBe(200);
    expect(group.json().result.itemGroup).toMatchObject({ itemGroupId: GROUP_ID });
    expect(group.json().result.itemGroup.items).toHaveLength(2);
    await app.http.close();
  });

  it('answers a pasted item group URL with the group instead of an opaque failure', async () => {
    const provider = createFakeProvider({
      listing: () => {
        throw new ItemGroupError(GROUP_ID);
      },
    });
    const app = buildApp({}, provider);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: `https://www.ebay.com/itm/${GROUP_ID}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({
      kind: 'itemGroup',
      itemGroup: { itemGroupId: GROUP_ID },
    });
    await app.http.close();
  });

  it('returns an actionable error when the group itself cannot be fetched', async () => {
    const provider = createFakeProvider({
      listing: () => {
        throw new ItemGroupError(GROUP_ID);
      },
    });
    const failing = {
      ...provider,
      getItemGroup: () => Promise.reject(new ItemGroupError(GROUP_ID)),
    };
    const app = buildApp({}, failing);
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: auth,
      payload: { item: `https://www.ebay.com/itm/${GROUP_ID}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'bad_request',
      details: { reason: 'item_group', itemGroupId: GROUP_ID, useTool: 'ebay_get_item_group' },
    });
    await app.http.close();
  });
});

describe('rate limiting', () => {
  it('returns 429 once the window is exhausted', async () => {
    const app = buildApp({ RATE_LIMIT_MAX: '2' });
    await app.http.ready();
    const headers = { authorization: ['Bearer', API_KEY].join(' ') };

    expect((await app.http.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(200);
    expect((await app.http.inject({ method: 'GET', url: '/tools', headers })).statusCode).toBe(200);
    const limited = await app.http.inject({ method: 'GET', url: '/tools', headers });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');

    await app.http.close();
  });
});

describe('disabled auth mode', () => {
  it('allows anonymous tool calls in development', async () => {
    const app = createApplication({
      config: testConfig({ AUTH_MODE: 'disabled' }),
      logger: createTestLogger() as unknown as Logger,
      provider: createFakeProvider(),
    });
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      payload: { item: '407111131587' },
    });
    expect(response.statusCode).toBe(200);

    await app.http.close();
  });

  it('omits the security requirement from the OpenAPI document', async () => {
    const app = createApplication({
      config: testConfig({ AUTH_MODE: 'disabled' }),
      logger: createTestLogger() as unknown as Logger,
      provider: createFakeProvider(),
    });
    await app.http.ready();

    const document = (await app.http.inject({ method: 'GET', url: '/openapi.json' })).json();
    expect(document.security).toEqual([]);

    await app.http.close();
  });
});
