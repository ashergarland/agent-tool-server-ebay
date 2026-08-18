import { describe, expect, it, vi } from 'vitest';
import { BrowseApiProvider, createEbayProvider } from '../../src/provider/ebay/index.js';
import { buildEndUserContext, EbayRestClient } from '../../src/provider/ebay/rest.js';
import { EbayTokenProvider } from '../../src/provider/ebay/oauth.js';
import { isRetryableStatus, mapEbayHttpError } from '../../src/provider/ebay/errors.js';
import { isItemGroupError, type ItemGroupError } from '../../src/errors.js';
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
    // 11003 is eBay's "legacy item id not found"; 11006 is reserved for item groups.
    const error = mapEbayHttpError(
      { status: 400, body: ebayErrorBody(11_003, 'The listing has ended.') },
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

/**
 * The production failure this suite guards: `ebay_search_listings` returned a row whose legacy id
 * (142373490668) is an item group parent, and `get_item_by_legacy_id` answered with eBay error
 * 11006 rather than an item.
 */
describe('BrowseApiProvider — item groups', () => {
  const GROUP_ID = '142373490668';

  /** eBay's real 11006 envelope, with the documented `{itemGroupHref}` parameter. */
  const itemGroupErrorBody = (extra: Record<string, unknown> = {}): unknown =>
    ebayErrorBody(
      11_006,
      'The legacy Id is invalid. Use ' +
        `/buy/browse/v1/item/get_items_by_item_group?item_group_id=${GROUP_ID} ` +
        'to get the item group details.',
      extra,
    );

  it('recognises the item group error id instead of failing generically', async () => {
    const { client } = buildClient([{ status: 400, body: itemGroupErrorBody() }]);
    const provider = new BrowseApiProvider(client);

    const error = await provider
      .getListing({ marketplaceId: 'EBAY_US', legacyItemId: GROUP_ID })
      .catch((caught: unknown) => caught);

    expect(isItemGroupError(error)).toBe(true);
    expect((error as ItemGroupError).itemGroupId).toBe(GROUP_ID);
    expect((error as ItemGroupError).details).toMatchObject({
      reason: 'item_group',
      itemGroupId: GROUP_ID,
      useTool: 'ebay_get_item_group',
    });
  });

  it('prefers the group id eBay names in the error parameters', async () => {
    const { client } = buildClient([
      {
        status: 400,
        body: itemGroupErrorBody({
          message: 'The legacy Id is invalid.',
          longMessage: 'The legacy Id is invalid.',
          parameters: [
            {
              name: 'itemGroupHref',
              value:
                'https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=999888777666',
            },
          ],
        }),
      },
    ]);
    const provider = new BrowseApiProvider(client);

    const error = (await provider
      .getListing({ marketplaceId: 'EBAY_US', legacyItemId: GROUP_ID })
      .catch((caught: unknown) => caught)) as ItemGroupError;

    expect(error.itemGroupId).toBe('999888777666');
  });

  it('falls back to the requested id when eBay names no group', async () => {
    const { client } = buildClient([
      { status: 400, body: ebayErrorBody(11_006, 'The legacy Id is invalid.') },
    ]);
    const provider = new BrowseApiProvider(client);

    const error = (await provider
      .getListing({ marketplaceId: 'EBAY_US', legacyItemId: GROUP_ID })
      .catch((caught: unknown) => caught)) as ItemGroupError;

    expect(error.itemGroupId).toBe(GROUP_ID);
  });

  it('does not misclassify other eBay 400s as item groups', async () => {
    const { client } = buildClient([
      { status: 400, body: ebayErrorBody(11_003, 'The specified item ID was not found.') },
    ]);
    const provider = new BrowseApiProvider(client);

    const error = await provider
      .getListing({ marketplaceId: 'EBAY_US', legacyItemId: GROUP_ID })
      .catch((caught: unknown) => caught);

    expect(isItemGroupError(error)).toBe(false);
  });

  it('calls get_items_by_item_group with the item_group_id parameter', async () => {
    const { client, fetch } = buildClient([{ status: 200, body: { items: [] } }]);
    const provider = new BrowseApiProvider(client);

    await provider.getItemGroup({ marketplaceId: 'EBAY_GB', itemGroupId: GROUP_ID });

    const request = browseRequests(fetch)[0];
    const url = new URL(request?.url ?? '');
    expect(url.pathname).toBe('/buy/browse/v1/item/get_items_by_item_group');
    expect(url.searchParams.get('item_group_id')).toBe(GROUP_ID);
    expect(request?.headers['x-ebay-c-marketplace-id']).toBe('EBAY_GB');
  });

  it('normalises every variation instead of picking one', async () => {
    const { client } = buildClient([
      {
        status: 200,
        body: {
          items: [
            {
              itemId: `v1|${GROUP_ID}|623456789012`,
              legacyItemId: GROUP_ID,
              title: 'Nintendo 64 Console — Charcoal',
              price: { value: '129.99', currency: 'USD' },
              condition: 'Used',
              conditionId: '3000',
              itemWebUrl: `https://www.ebay.com/itm/${GROUP_ID}`,
              image: { imageUrl: 'https://i.ebayimg.com/images/g/charcoal/s-l1600.jpg' },
              seller: { username: 'retro_seller', feedbackPercentage: '99.4' },
              localizedAspects: [
                { name: 'Brand', value: 'Nintendo' },
                { name: 'Colour', value: 'Charcoal' },
              ],
              estimatedAvailabilities: [
                { estimatedAvailabilityStatus: 'IN_STOCK', estimatedAvailableQuantity: 3 },
              ],
              shippingOptions: [{ shippingCost: { value: '9.99', currency: 'USD' } }],
              primaryItemGroup: {
                itemGroupId: GROUP_ID,
                itemGroupType: 'SELLER_DEFINED_VARIATIONS',
                itemGroupTitle: 'Nintendo 64 Console — choose your colour',
                itemGroupImage: { imageUrl: 'https://i.ebayimg.com/images/g/group/s-l1600.jpg' },
              },
            },
            {
              itemId: `v1|${GROUP_ID}|623456789013`,
              legacyItemId: GROUP_ID,
              title: 'Nintendo 64 Console — Blue',
              price: { value: '149.99', currency: 'USD' },
              condition: 'Used',
              conditionId: '3000',
              localizedAspects: [
                { name: 'Brand', value: 'Nintendo' },
                { name: 'Colour', value: 'Blue' },
              ],
              estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }],
              primaryItemGroup: { itemGroupId: GROUP_ID },
            },
          ],
          warnings: [{ errorId: 12_501, longMessage: 'One variation was suppressed.' }],
        },
      },
    ]);
    const provider = new BrowseApiProvider(client);

    const group = await provider.getItemGroup({ marketplaceId: 'EBAY_US', itemGroupId: GROUP_ID });

    expect(group.itemGroupId).toBe(GROUP_ID);
    expect(group.itemGroupType).toBe('SELLER_DEFINED_VARIATIONS');
    expect(group.title).toBe('Nintendo 64 Console — choose your colour');
    expect(group.imageUrl).toBe('https://i.ebayimg.com/images/g/group/s-l1600.jpg');
    expect(group.items).toHaveLength(2);
    expect(group.items.map((item) => item.itemId)).toEqual([
      `v1|${GROUP_ID}|623456789012`,
      `v1|${GROUP_ID}|623456789013`,
    ]);
    expect(group.items[0]).toMatchObject({
      title: 'Nintendo 64 Console — Charcoal',
      price: { value: 129.99, currency: 'USD' },
      condition: 'Used',
      itemWebUrl: `https://www.ebay.com/itm/${GROUP_ID}`,
      imageUrl: 'https://i.ebayimg.com/images/g/charcoal/s-l1600.jpg',
      lowestShippingCost: { value: 9.99, currency: 'USD' },
      estimatedDeliveredTotal: { value: 139.98, currency: 'USD' },
      active: true,
    });
    expect(group.items[0]?.seller.username).toBe('retro_seller');
    expect(group.items[0]?.availability?.availableQuantity).toBe(3);
    expect(group.items[1]?.active).toBe(false);
    // Only the aspect that actually differs is reported as the distinguishing one.
    expect(group.varyingAspects).toEqual(['Colour']);
    expect(group.warnings).toEqual(['One variation was suppressed.']);
  });

  it('tolerates a group response with no items', async () => {
    const { client } = buildClient([{ status: 200, body: {} }]);
    const provider = new BrowseApiProvider(client);

    const group = await provider.getItemGroup({ marketplaceId: 'EBAY_US', itemGroupId: GROUP_ID });
    expect(group).toMatchObject({ itemGroupId: GROUP_ID, items: [], varyingAspects: [] });
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
