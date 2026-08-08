import { describe, expect, it, vi } from 'vitest';
import { BrowseApiProvider, createEbayProvider } from '../../src/provider/ebay/index.js';
import { buildEndUserContext, EbayRestClient } from '../../src/provider/ebay/rest.js';
import { EbayTokenProvider } from '../../src/provider/ebay/oauth.js';
import { isRetryableStatus, mapEbayHttpError } from '../../src/provider/ebay/errors.js';
import {
  createFakeFetch,
  ebayErrorBody,
  tokenResponse,
  type StubResponse,
} from '../helpers/fake-fetch.js';
import { testConfig } from '../helpers/config.js';

const buildClient = (stubs: readonly StubResponse[], overrides: Record<string, unknown> = {}) => {
  // The first stub is always the OAuth token; the rest answer Browse API calls.
  const fetch = createFakeFetch([tokenResponse(), ...stubs]);
  const tokens = new EbayTokenProvider({
    tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
    clientId: 'id',
    clientSecret: 'secret',
    scopes: ['https://api.ebay.com/oauth/api_scope'],
    refreshSkewMs: 0,
    timeoutMs: 1_000,
    fetchImpl: fetch.fetchImpl,
  });
  const sleep = vi.fn(() => Promise.resolve());
  const client = new EbayRestClient({
    baseUrl: 'https://api.ebay.com',
    tokens,
    timeoutMs: 1_000,
    maxRetries: 2,
    retryBaseDelayMs: 1,
    fetchImpl: fetch.fetchImpl,
    sleep,
    ...overrides,
  });
  return { client, fetch, tokens, sleep };
};

/** Browse API requests are every request after the initial OAuth token exchange. */
const browseRequests = (fetch: ReturnType<typeof createFakeFetch>) =>
  fetch.requests.filter((request) => !request.url.includes('/identity/'));

describe('EbayRestClient — request construction', () => {
  it('sends the bearer token and marketplace header', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: { itemId: 'v1|1|0' } }]);

    await client.get('/buy/browse/v1/item/v1%7C1%7C0', {
      marketplaceId: 'EBAY_GB',
      context: 'getListing',
    });

    const request = browseRequests(fetch)[0];
    expect(request?.headers['authorization']).toBe('Bearer token-1');
    expect(request?.headers['x-ebay-c-marketplace-id']).toBe('EBAY_GB');
    expect(request?.method).toBe('GET');
  });

  it('appends query parameters and omits undefined ones', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: {} }]);

    await client.get('/buy/browse/v1/item_summary/search', {
      marketplaceId: 'EBAY_US',
      query: { q: 'sega saturn', limit: 20, filter: undefined },
      context: 'searchListings',
    });

    const url = new URL(browseRequests(fetch)[0]?.url ?? '');
    expect(url.pathname).toBe('/buy/browse/v1/item_summary/search');
    expect(url.searchParams.get('q')).toBe('sega saturn');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.has('filter')).toBe(false);
  });

  it('omits the end user context header when no buyer location is configured', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: {} }]);
    await client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' });
    expect(browseRequests(fetch)[0]?.headers['x-ebay-c-enduserctx']).toBeUndefined();
  });

  it('sends the buyer context header when a delivery location is configured', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: {} }], {
      deliveryCountry: 'US',
      deliveryPostalCode: '19406',
    });
    await client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' });
    expect(browseRequests(fetch)[0]?.headers['x-ebay-c-enduserctx']).toBe(
      'contextualLocation=country%3DUS%2Czip%3D19406',
    );
  });
});

describe('buildEndUserContext', () => {
  it('URL-encodes the contextual location value', () => {
    expect(buildEndUserContext({ deliveryCountry: 'US', deliveryPostalCode: '19406' })).toBe(
      'contextualLocation=country%3DUS%2Czip%3D19406',
    );
  });

  it('supports a country with no postal code', () => {
    expect(buildEndUserContext({ deliveryCountry: 'GB' })).toBe('contextualLocation=country%3DGB');
  });

  it('includes the affiliate campaign id first', () => {
    expect(buildEndUserContext({ affiliateCampaignId: '1234567890', deliveryCountry: 'US' })).toBe(
      'affiliateCampaignId=1234567890,contextualLocation=country%3DUS',
    );
  });

  it('returns undefined when nothing is configured', () => {
    expect(buildEndUserContext({})).toBeUndefined();
  });
});

describe('EbayRestClient — error handling', () => {
  it('maps a 404 to not_found without retrying', async () => {
    const { client, fetch, sleep } = buildClient([
      { status: 404, body: ebayErrorBody(11_001, 'The item was not found.') },
    ]);

    await expect(
      client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(browseRequests(fetch)).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('maps a 403 to forbidden and explains the eBay account requirement', async () => {
    const { client } = buildClient([{ status: 403, body: ebayErrorBody(1100, 'Access denied') }]);

    await expect(
      client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' }),
    ).rejects.toThrow(/Browse API access/);
  });

  it('retries a 503 and succeeds', async () => {
    const { client, fetch, sleep } = buildClient([
      { status: 503, body: {} },
      { status: 200, body: { itemId: 'v1|1|0' } },
    ]);

    const result = await client.get<{ itemId: string }>('/buy/browse/v1/item/x', {
      marketplaceId: 'EBAY_US',
      context: 'getListing',
    });

    expect(result.itemId).toBe('v1|1|0');
    expect(browseRequests(fetch)).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured number of retries', async () => {
    const { client, fetch } = buildClient([{ status: 500, body: {} }]);

    await expect(
      client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
    expect(browseRequests(fetch)).toHaveLength(3);
  });

  it('honours Retry-After on a 429', async () => {
    const { client, sleep } = buildClient([
      { status: 429, body: {}, headers: { 'retry-after': '2' } },
      { status: 200, body: {} },
    ]);

    await client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' });
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('reports sustained throttling as rate_limited', async () => {
    const { client } = buildClient([{ status: 429, body: {} }]);

    await expect(
      client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' }),
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('refreshes the token once on a 401 and retries', async () => {
    const fetch = createFakeFetch([
      tokenResponse('token-1'),
      { status: 401, body: ebayErrorBody(1001, 'Invalid access token') },
      tokenResponse('token-2'),
      { status: 200, body: { itemId: 'v1|1|0' } },
    ]);
    const tokens = new EbayTokenProvider({
      tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
      clientId: 'id',
      clientSecret: 'secret',
      scopes: ['scope'],
      refreshSkewMs: 0,
      timeoutMs: 1_000,
      fetchImpl: fetch.fetchImpl,
    });
    const client = new EbayRestClient({
      baseUrl: 'https://api.ebay.com',
      tokens,
      timeoutMs: 1_000,
      maxRetries: 2,
      retryBaseDelayMs: 1,
      fetchImpl: fetch.fetchImpl,
      sleep: () => Promise.resolve(),
    });

    await client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' });

    expect(tokens.fetchCount).toBe(2);
    expect(browseRequests(fetch)[1]?.headers['authorization']).toBe('Bearer token-2');
  });

  it('does not loop forever on a persistent 401', async () => {
    const { client } = buildClient([{ status: 401, body: {} }]);

    await expect(
      client.get('/buy/browse/v1/item/x', { marketplaceId: 'EBAY_US', context: 'getListing' }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('treats an ended-listing 400 as not_found', () => {
    const error = mapEbayHttpError(
      { status: 400, body: ebayErrorBody(11_006, 'The listing has ended.') },
      'getListing',
    );
    expect(error.code).toBe('not_found');
  });

  it('treats an ordinary 400 as bad_request', () => {
    const error = mapEbayHttpError(
      { status: 400, body: ebayErrorBody(12_001, 'Invalid filter syntax.') },
      'searchListings',
    );
    expect(error.code).toBe('bad_request');
  });

  it('classifies retryable statuses', () => {
    expect([429, 500, 502, 503, 504].every(isRetryableStatus)).toBe(true);
    expect([400, 401, 403, 404, 409].some(isRetryableStatus)).toBe(false);
  });
});

describe('BrowseApiProvider', () => {
  it('fetches by Browse item id with the PRODUCT fieldgroup', async () => {
    const { client, fetch } = buildClient([
      { status: 200, body: { itemId: 'v1|407111131587|0', title: 'Console' } },
    ]);
    const provider = new BrowseApiProvider(client);

    const listing = await provider.getListing({
      marketplaceId: 'EBAY_US',
      itemId: 'v1|407111131587|0',
    });

    expect(listing.title).toBe('Console');
    const url = new URL(browseRequests(fetch)[0]?.url ?? '');
    expect(url.pathname).toBe('/buy/browse/v1/item/v1%7C407111131587%7C0');
    expect(url.searchParams.get('fieldgroups')).toBe('PRODUCT');
  });

  it('fetches by legacy id through the legacy endpoint', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: { title: 'Console' } }]);
    const provider = new BrowseApiProvider(client);

    await provider.getListing({
      marketplaceId: 'EBAY_US',
      legacyItemId: '407111131587',
      legacyVariationId: '99',
    });

    const url = new URL(browseRequests(fetch)[0]?.url ?? '');
    expect(url.pathname).toBe('/buy/browse/v1/item/get_item_by_legacy_id');
    expect(url.searchParams.get('legacy_item_id')).toBe('407111131587');
    expect(url.searchParams.get('legacy_variation_id')).toBe('99');
  });

  it('rejects a getListing call with no identifier at all', async () => {
    const { client } = buildClient([]);
    const provider = new BrowseApiProvider(client);

    await expect(provider.getListing({ marketplaceId: 'EBAY_US' })).rejects.toMatchObject({
      code: 'bad_request',
    });
  });

  it('searches with the built filter expression', async () => {
    const { client, fetch } = buildClient([
      {
        status: 200,
        body: { total: 2, itemSummaries: [{ itemId: 'v1|1|0' }, { itemId: 'v1|2|0' }] },
      },
    ]);
    const provider = new BrowseApiProvider(client);

    const result = await provider.searchListings({
      marketplaceId: 'EBAY_US',
      query: 'sega saturn',
      minPrice: 50,
      maxPrice: 150,
      conditions: ['USED'],
      sort: 'priceAsc',
      limit: 10,
      offset: 0,
    });

    expect(result.listings).toHaveLength(2);
    expect(result.total).toBe(2);
    const url = new URL(browseRequests(fetch)[0]?.url ?? '');
    expect(url.searchParams.get('filter')).toBe(
      'price:[50..150],priceCurrency:USD,conditions:{USED}',
    );
    expect(url.searchParams.get('sort')).toBe('price');
    expect(result.appliedFilter).toBe('price:[50..150],priceCurrency:USD,conditions:{USED}');
  });

  it('omits the sort parameter for best match', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: { itemSummaries: [] } }]);
    const provider = new BrowseApiProvider(client);

    await provider.searchListings({
      marketplaceId: 'EBAY_US',
      query: 'ps2',
      sort: 'bestMatch',
      limit: 5,
      offset: 0,
    });

    expect(new URL(browseRequests(fetch)[0]?.url ?? '').searchParams.has('sort')).toBe(false);
  });

  it('tolerates a search response with no itemSummaries', async () => {
    const { client } = buildClient([{ status: 200, body: { total: 0 } }]);
    const provider = new BrowseApiProvider(client);

    const result = await provider.searchListings({
      marketplaceId: 'EBAY_US',
      query: 'nothing matches this',
      sort: 'bestMatch',
      limit: 5,
      offset: 0,
    });
    expect(result.listings).toEqual([]);
  });

  it('surfaces eBay warnings alongside the results', async () => {
    const { client } = buildClient([
      {
        status: 200,
        body: {
          itemSummaries: [],
          warnings: [{ errorId: 12_501, longMessage: 'The category id was ignored.' }],
        },
      },
    ]);
    const provider = new BrowseApiProvider(client);

    const result = await provider.searchListings({
      marketplaceId: 'EBAY_US',
      query: 'ps2',
      sort: 'bestMatch',
      limit: 5,
      offset: 0,
    });
    expect(result.warnings).toEqual(['The category id was ignored.']);
  });

  it('refuses a search with no query, category, epid or gtin', async () => {
    const { client } = buildClient([]);
    const provider = new BrowseApiProvider(client);

    await expect(
      provider.searchListings({
        marketplaceId: 'EBAY_US',
        sort: 'bestMatch',
        limit: 5,
        offset: 0,
      }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('createEbayProvider', () => {
  it('fails loudly when credentials are missing', () => {
    const config = testConfig({ EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: undefined });
    expect(() => createEbayProvider(config)).toThrow(/EBAY_CLIENT_ID/);
  });

  it('builds a provider when credentials are present', () => {
    expect(createEbayProvider(testConfig())).toBeInstanceOf(BrowseApiProvider);
  });
});
