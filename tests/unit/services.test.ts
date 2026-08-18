import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { createServices } from '../../src/services/index.js';
import { AppError, isItemGroupError, ItemGroupError } from '../../src/errors.js';
import type { GetListingInput, SearchInput } from '../../src/provider/types.js';
import { testConfig } from '../helpers/config.js';
import {
  createFakeProvider,
  createTestLogger,
  makeListing,
  makeSummary,
  type FakeProviderOptions,
} from '../helpers/fake-provider.js';

const build = (
  providerOptions: FakeProviderOptions = {},
  configOverrides: Record<string, string | undefined> = {},
) => {
  const provider = createFakeProvider(providerOptions);
  const services = createServices(
    testConfig(configOverrides),
    provider,
    createTestLogger() as unknown as Logger,
  );
  return { provider, services };
};

const lastCall = (provider: ReturnType<typeof createFakeProvider>, name: string) =>
  [...provider.calls].reverse().find((call) => call.name === name);

describe('ListingsService.getListing', () => {
  it('fetches a pasted listing URL through the legacy id endpoint', async () => {
    const { provider, services } = build();
    const result = await services.listings.getListing({
      item: 'https://www.ebay.com/itm/Sony-PS2/407111131587?hash=abc',
    });

    expect(result.listing.itemId).toBe('v1|407111131587|0');
    expect(lastCall(provider, 'getListing')?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      legacyItemId: '407111131587',
    });
  });

  it('uses the Browse item id endpoint when the caller supplies one', async () => {
    const { provider, services } = build();
    await services.listings.getListing({ item: 'v1|407111131587|0' });

    // eBay documents Browse item ids and legacy ids as separate identifier spaces: an explicitly
    // supplied Browse id must reach GET /item/{item_id} unchanged, never get_item_by_legacy_id.
    const input = lastCall(provider, 'getListing')?.args[0] as GetListingInput;
    expect(input.itemId).toBe('v1|407111131587|0');
    expect(input.legacyItemId).toBeUndefined();
    expect(input.legacyVariationId).toBeUndefined();
  });

  it('keeps the variation segment of a supplied Browse item id', async () => {
    const { provider, services } = build();
    await services.listings.getListing({ item: 'v1|142373490668|623456789012' });

    expect(lastCall(provider, 'getListing')?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemId: 'v1|142373490668|623456789012',
    });
  });

  it('passes the variation id through', async () => {
    const { provider, services } = build();
    await services.listings.getListing({ item: 'https://www.ebay.com/itm/407111131587?var=99' });

    expect(lastCall(provider, 'getListing')?.args[0]).toMatchObject({
      legacyItemId: '407111131587',
      legacyVariationId: '99',
    });
  });

  it('infers the marketplace from the pasted country site', async () => {
    const { provider, services } = build();
    await services.listings.getListing({ item: 'https://www.ebay.co.uk/itm/407111131587' });

    expect((lastCall(provider, 'getListing')?.args[0] as GetListingInput).marketplaceId).toBe(
      'EBAY_GB',
    );
  });

  it('lets an explicit marketplace override the URL host', async () => {
    const { provider, services } = build();
    await services.listings.getListing({
      item: 'https://www.ebay.co.uk/itm/407111131587',
      marketplaceId: 'EBAY_DE',
    });

    expect((lastCall(provider, 'getListing')?.args[0] as GetListingInput).marketplaceId).toBe(
      'EBAY_DE',
    );
  });

  it('falls back to the configured default marketplace for a bare item id', async () => {
    const { provider, services } = build({}, { EBAY_MARKETPLACE_ID: 'EBAY_AU' });
    await services.listings.getListing({ item: '407111131587' });

    expect((lastCall(provider, 'getListing')?.args[0] as GetListingInput).marketplaceId).toBe(
      'EBAY_AU',
    );
  });

  it('rejects an unsupported marketplace before calling eBay', async () => {
    const { provider, services } = build();
    await expect(
      services.listings.getListing({ item: '407111131587', marketplaceId: 'EBAY_IN' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(provider.calls).toHaveLength(0);
  });

  it('explains that a product page is not a listing', async () => {
    const { services } = build();
    await expect(
      services.listings.getListing({ item: 'https://www.ebay.com/p/2296658' }),
    ).rejects.toThrow(/catalogue product page/);
  });

  it('returns an ended listing rather than hiding it', async () => {
    const { services } = build({
      listing: makeListing({ active: false, ended: true, secondsRemaining: -3600 }),
    });
    const result = await services.listings.getListing({ item: '407111131587' });
    expect(result.listing.active).toBe(false);
  });
});

/**
 * Reproduces the production failure end to end at the service boundary: a pasted `/itm/<id>` URL
 * whose numeric id is really an item group parent. The URL itself cannot reveal that, so the
 * connector has to act on eBay's structured 11006 answer.
 */
describe('ListingsService — legacy ids that turn out to be item groups', () => {
  const GROUP_ID = '142373490668';

  const buildGroupProvider = (options: FakeProviderOptions = {}) =>
    build({
      listing: () => {
        throw new ItemGroupError(GROUP_ID);
      },
      ...options,
    });

  it('surfaces a specific item-group failure rather than an opaque bad request', async () => {
    const { services } = buildGroupProvider();

    const error = await services.listings
      .getListing({ item: `https://www.ebay.com/itm/${GROUP_ID}` })
      .catch((caught: unknown) => caught);

    expect(isItemGroupError(error)).toBe(true);
    expect((error as ItemGroupError).details).toMatchObject({
      reason: 'item_group',
      itemGroupId: GROUP_ID,
      useTool: 'ebay_get_item_group',
    });
    expect((error as ItemGroupError).message).toContain('ebay_get_item_group');
  });

  it('resolves the group through getItemsByItemGroup and reports it as a group', async () => {
    const { provider, services } = buildGroupProvider();

    const resolved = await services.listings.resolveItem({
      item: `https://www.ebay.com/itm/${GROUP_ID}`,
    });

    expect(resolved.kind).toBe('itemGroup');
    if (resolved.kind !== 'itemGroup') expect.unreachable();
    expect(resolved.itemGroup.itemGroupId).toBe(GROUP_ID);
    // Every variation is returned; none is promoted to stand for the whole group.
    expect(resolved.itemGroup.items.length).toBeGreaterThan(1);
    expect(lastCall(provider, 'getItemGroup')?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemGroupId: GROUP_ID,
    });
  });

  it('keeps the marketplace implied by the pasted URL when resolving the group', async () => {
    const { provider, services } = buildGroupProvider();
    await services.listings.resolveItem({ item: `https://www.ebay.co.uk/itm/${GROUP_ID}` });

    expect(lastCall(provider, 'getItemGroup')?.args[0]).toMatchObject({
      marketplaceId: 'EBAY_GB',
    });
  });

  it('reports a single listing as a listing', async () => {
    const { services } = build();
    const resolved = await services.listings.resolveItem({ item: '407111131587' });

    expect(resolved.kind).toBe('listing');
    if (resolved.kind !== 'listing') expect.unreachable();
    expect(resolved.listing.itemId).toBe('v1|407111131587|0');
  });

  it('rethrows the actionable item-group error when the group lookup itself fails', async () => {
    const { services } = buildGroupProvider({
      itemGroup: () => {
        throw new AppError('upstream_error', 'getItemGroup: eBay returned 503');
      },
    });

    await expect(
      services.listings.resolveItem({ item: `https://www.ebay.com/itm/${GROUP_ID}` }),
    ).rejects.toMatchObject({ code: 'upstream_error' });
  });

  it('does not swallow unrelated failures', async () => {
    const { services } = build({
      listing: () => {
        throw new AppError('not_found', 'getListing: The item was not found.');
      },
    });

    await expect(services.listings.getListing({ item: '407111131587' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('ListingsService.getItemGroup', () => {
  const GROUP_ID = '142373490668';

  it('fetches a bare group id against the configured marketplace', async () => {
    const { provider, services } = build();
    const result = await services.listings.getItemGroup({ itemGroup: GROUP_ID });

    expect(lastCall(provider, 'getItemGroup')?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemGroupId: GROUP_ID,
    });
    expect(result.itemGroup.items[0]?.itemId).toBe(`v1|${GROUP_ID}|623456789012`);
    expect(result.reference.itemGroupId).toBe(GROUP_ID);
  });

  it('accepts the parent listing URL and infers its marketplace', async () => {
    const { provider, services } = build();
    await services.listings.getItemGroup({ itemGroup: `https://www.ebay.de/itm/${GROUP_ID}` });

    expect(lastCall(provider, 'getItemGroup')?.args[0]).toMatchObject({
      marketplaceId: 'EBAY_DE',
      itemGroupId: GROUP_ID,
    });
  });

  it("accepts a variation's Browse item id", async () => {
    const { provider, services } = build();
    await services.listings.getItemGroup({ itemGroup: `v1|${GROUP_ID}|623456789013` });

    expect(lastCall(provider, 'getItemGroup')?.args[0]).toMatchObject({ itemGroupId: GROUP_ID });
  });

  it('rejects an unsupported marketplace before calling eBay', async () => {
    const { provider, services } = build();
    await expect(
      services.listings.getItemGroup({ itemGroup: GROUP_ID, marketplaceId: 'EBAY_IN' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(provider.calls).toHaveLength(0);
  });
});

/**
 * The invariant the production bug broke: an identifier taken from a search result must be usable
 * with the matching detail tool without any rewriting.
 */
describe('search result to detail handoff', () => {
  it('passes a returned RESTful itemId straight through to getItem', async () => {
    const { provider, services } = build({
      search: { listings: [makeSummary({ itemId: 'v1|407111131587|0' })] },
    });

    const search = await services.listings.searchListings({ query: 'nintendo 64 console' });
    const first = search.listings[0];
    expect(first?.itemId).toBe('v1|407111131587|0');

    await services.listings.getListing({ item: first?.itemId ?? '' });

    expect(lastCall(provider, 'getListing')?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemId: 'v1|407111131587|0',
    });
  });

  it('routes a search row that is an item group to the item group lookup', async () => {
    const GROUP_ID = '142373490668';
    const { provider, services } = build({
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

    const search = await services.listings.searchListings({ query: 'nintendo 64 console' });
    const row = search.listings[0];
    expect(row?.itemGroupType).toBe('SELLER_DEFINED_VARIATIONS');

    await services.listings.getItemGroup({ itemGroup: row?.itemGroupId ?? '' });

    expect(lastCall(provider, 'getItemGroup')?.args[0]).toMatchObject({ itemGroupId: GROUP_ID });
  });
});

describe('ListingsService.searchListings', () => {
  it('applies the configured default limit', async () => {
    const { provider, services } = build();
    await services.listings.searchListings({ query: 'sega saturn' });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).limit).toBe(20);
  });

  it('clamps an oversized limit', async () => {
    const { provider, services } = build();
    await services.listings.searchListings({ query: 'sega saturn', limit: 999 });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).limit).toBe(50);
  });

  it('maps auctionOnly to a buying option filter', async () => {
    const { provider, services } = build();
    await services.listings.searchListings({ query: 'n64', auctionOnly: true });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).buyingOptions).toEqual([
      'AUCTION',
    ]);
  });

  it('maps buyItNowOnly to a fixed price filter', async () => {
    const { provider, services } = build();
    await services.listings.searchListings({ query: 'n64', buyItNowOnly: true });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).buyingOptions).toEqual([
      'FIXED_PRICE',
    ]);
  });

  it('rejects mutually exclusive buying format filters', async () => {
    const { provider, services } = build();
    await expect(
      services.listings.searchListings({ query: 'n64', auctionOnly: true, buyItNowOnly: true }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(provider.calls).toHaveLength(0);
  });

  it('applies the configured default buyer location', async () => {
    const { provider, services } = build(
      {},
      { EBAY_DELIVERY_COUNTRY: 'US', EBAY_DELIVERY_POSTAL_CODE: '19406' },
    );
    await services.listings.searchListings({ query: 'ps2' });

    expect(lastCall(provider, 'searchListings')?.args[0]).toMatchObject({
      deliveryCountry: 'US',
      deliveryPostalCode: '19406',
    });
  });

  it('does not mix a caller delivery country with the configured postal code', async () => {
    const { provider, services } = build(
      {},
      { EBAY_DELIVERY_COUNTRY: 'US', EBAY_DELIVERY_POSTAL_CODE: '19406' },
    );
    await services.listings.searchListings({ query: 'ps2', deliveryCountry: 'GB' });

    expect(lastCall(provider, 'searchListings')?.args[0]).toMatchObject({
      deliveryCountry: 'GB',
      deliveryPostalCode: undefined,
    });
  });

  it('defaults to best match ordering and the first page', async () => {
    const { provider, services } = build();
    await services.listings.searchListings({ query: 'ps2' });

    expect(lastCall(provider, 'searchListings')?.args[0]).toMatchObject({
      sort: 'bestMatch',
      offset: 0,
    });
  });
});

describe('ComparisonService.findSimilarListings', () => {
  it('prefers an EPID search when the listing is in the eBay catalogue', async () => {
    const { provider, services } = build({
      listing: makeListing({
        productIdentifiers: { epid: '2296658', brand: 'Sony', mpn: undefined, gtin: undefined },
      }),
    });

    const result = await services.comparison.findSimilarListings({ item: '407111131587' });

    expect(result.strategy).toBe('epid');
    expect(lastCall(provider, 'searchListings')?.args[0]).toMatchObject({ epid: '2296658' });
  });

  it('falls back to a GTIN search when there is no EPID', async () => {
    const { provider, services } = build({
      listing: makeListing({
        productIdentifiers: {
          epid: undefined,
          brand: 'Sony',
          mpn: undefined,
          gtin: '4974365801007',
        },
      }),
    });

    const result = await services.comparison.findSimilarListings({ item: '407111131587' });
    expect(result.strategy).toBe('gtin');
    expect(lastCall(provider, 'searchListings')?.args[0]).toMatchObject({ gtin: '4974365801007' });
  });

  it('falls back to distilled title keywords for an uncatalogued item', async () => {
    const { provider, services } = build({
      listing: makeListing({
        title: 'RARE!! L@@K Sony PlayStation 2 Slim SCPH-70012 Console FREE SHIP NR',
      }),
    });

    const result = await services.comparison.findSimilarListings({ item: '407111131587' });

    expect(result.strategy).toBe('keywords');
    const query = (lastCall(provider, 'searchListings')?.args[0] as SearchInput).query ?? '';
    expect(query).toContain('Sony');
    expect(query).toContain('SCPH-70012');
    expect(query.toLowerCase()).not.toContain('rare');
    expect(query.toLowerCase()).not.toContain('free');
    expect(query.toLowerCase()).not.toContain('l@@k');
  });

  it('widens the strategy when the precise search returns nothing', async () => {
    let call = 0;
    const { services } = build({
      listing: makeListing({
        productIdentifiers: { epid: '2296658', brand: 'Sony', mpn: undefined, gtin: undefined },
      }),
      search: () => {
        call += 1;
        return call === 1 ? { listings: [], total: 0 } : {};
      },
    });

    const result = await services.comparison.findSimilarListings({ item: '407111131587' });
    expect(result.strategy).toBe('keywords');
    expect(result.notes.some((note) => note.includes('broader strategy'))).toBe(true);
  });

  it('restricts comparables to the source category by default', async () => {
    const { provider, services } = build();
    await services.comparison.findSimilarListings({ item: '407111131587' });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).categoryIds).toEqual([
      '139971',
    ]);
  });

  it('can search outside the source category', async () => {
    const { provider, services } = build();
    await services.comparison.findSimilarListings({
      item: '407111131587',
      sameCategoryOnly: false,
    });

    expect(
      (lastCall(provider, 'searchListings')?.args[0] as SearchInput).categoryIds,
    ).toBeUndefined();
  });

  it('maps a used source condition to the USED bucket when asked to match', async () => {
    const { provider, services } = build();
    await services.comparison.findSimilarListings({ item: '407111131587', matchCondition: true });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).conditions).toEqual([
      'USED',
    ]);
  });

  it('maps a new source condition to the NEW bucket', async () => {
    const { provider, services } = build({ listing: makeListing({ conditionId: '1000' }) });
    await services.comparison.findSimilarListings({ item: '407111131587', matchCondition: true });

    expect((lastCall(provider, 'searchListings')?.args[0] as SearchInput).conditions).toEqual([
      'NEW',
    ]);
  });

  it('notes when the source has no condition to match on', async () => {
    const { services } = build({ listing: makeListing({ conditionId: undefined }) });
    const result = await services.comparison.findSimilarListings({
      item: '407111131587',
      matchCondition: true,
    });

    expect(result.notes.some((note) => note.includes('no condition id'))).toBe(true);
  });

  it('excludes the source listing from its own comparables', async () => {
    const { services } = build({
      search: {
        listings: [
          makeSummary({ itemId: 'v1|407111131587|0', legacyItemId: '407111131587' }),
          makeSummary({ itemId: 'v1|999999999999|0', legacyItemId: '999999999999' }),
        ],
        total: 2,
      },
    });

    const result = await services.comparison.findSimilarListings({ item: '407111131587' });
    expect(result.comparables.map((row) => row.legacyItemId)).toEqual(['999999999999']);
  });

  it('bounds the comparable set to the requested limit', async () => {
    const { services } = build({
      search: {
        listings: Array.from({ length: 20 }, (_, index) =>
          makeSummary({
            itemId: `v1|10000000000${index}|0`,
            legacyItemId: `10000000000${index}`,
          }),
        ),
      },
    });

    const result = await services.comparison.findSimilarListings({
      item: '407111131587',
      limit: 3,
    });
    expect(result.comparables).toHaveLength(3);
  });

  it('reports honestly when eBay has no comparables at all', async () => {
    const { services } = build({ search: { listings: [], total: 0 } });
    const result = await services.comparison.findSimilarListings({ item: '407111131587' });

    expect(result.comparables).toEqual([]);
    expect(result.notes.some((note) => note.includes('no active comparable'))).toBe(true);
  });
});

describe('ComparisonService.compareListings', () => {
  const twoListings = (): FakeProviderOptions => ({
    listing: (input) =>
      input.legacyItemId === '111111111111'
        ? makeListing({
            itemId: 'v1|111111111111|0',
            legacyItemId: '111111111111',
            price: { value: 100, currency: 'USD' },
            lowestShippingCost: { value: 0, currency: 'USD' },
            estimatedDeliveredTotal: { value: 100, currency: 'USD' },
            condition: 'Used',
            seller: {
              username: 'seller_a',
              feedbackPercentage: 99.9,
              feedbackScore: 5000,
              sellerAccountType: undefined,
            },
            itemSpecifics: [{ name: 'Region Code', value: 'NTSC-U' }],
          })
        : makeListing({
            itemId: 'v1|222222222222|0',
            legacyItemId: '222222222222',
            price: { value: 120, currency: 'USD' },
            lowestShippingCost: { value: 15, currency: 'USD' },
            estimatedDeliveredTotal: { value: 135, currency: 'USD' },
            condition: 'For parts or not working',
            buyingOptions: ['AUCTION'],
            isAuction: true,
            isFixedPrice: false,
            bidCount: 4,
            seller: {
              username: 'seller_b',
              feedbackPercentage: 91.2,
              feedbackScore: 40,
              sellerAccountType: undefined,
            },
            returnTerms: {
              returnsAccepted: false,
              returnPeriodDays: undefined,
              refundMethod: undefined,
              returnMethod: undefined,
              returnShippingCostPayer: undefined,
              restockingFeePercentage: undefined,
            },
            itemSpecifics: [{ name: 'Region Code', value: 'PAL' }],
          }),
  });

  it('returns one row per requested item', async () => {
    const { services } = build(twoListings());
    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });

    expect(result.listings.map((row) => row.legacyItemId)).toEqual([
      '111111111111',
      '222222222222',
    ]);
  });

  it('reports the delivered total range', async () => {
    const { services } = build(twoListings());
    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });

    expect(result.differences.some((line) => line.includes('100.00 USD to 135.00 USD'))).toBe(true);
  });

  it('reports differing conditions, formats, returns and feedback', async () => {
    const { services } = build(twoListings());
    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });
    const text = result.differences.join('\n');

    expect(text).toMatch(/Conditions differ/);
    expect(text).toMatch(/1 of 2 listings are auctions/);
    expect(text).toMatch(/1 of 2 sellers accept returns/);
    expect(text).toMatch(/Seller feedback ranges from 91.2% to 99.9%/);
    expect(text).toMatch(/Region Code: NTSC-U vs PAL/);
  });

  it('flags listings that are no longer active', async () => {
    const { services } = build({
      listing: (input) =>
        makeListing({
          legacyItemId: input.legacyItemId ?? '1',
          active: input.legacyItemId === '222222222222' ? false : true,
          ended: input.legacyItemId === '222222222222',
        }),
    });

    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });
    expect(result.unavailableCount).toBe(1);
    expect(result.differences.some((line) => line.includes('no longer active'))).toBe(true);
  });

  it('warns rather than compares when currencies differ', async () => {
    const { services } = build({
      listing: (input) =>
        makeListing({
          legacyItemId: input.legacyItemId ?? '1',
          estimatedDeliveredTotal: {
            value: 100,
            currency: input.legacyItemId === '222222222222' ? 'GBP' : 'USD',
          },
        }),
    });

    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });
    expect(result.differences.some((line) => line.includes('different currencies'))).toBe(true);
  });

  it('notes listings with no delivered total', async () => {
    const { services } = build({
      listing: (input) =>
        makeListing({
          legacyItemId: input.legacyItemId ?? '1',
          estimatedDeliveredTotal:
            input.legacyItemId === '222222222222' ? undefined : { value: 100, currency: 'USD' },
        }),
    });

    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });
    expect(
      result.differences.some((line) => line.includes('do not expose a delivered total')),
    ).toBe(true);
  });

  it('always states that it gives no recommendation', async () => {
    const { services } = build(twoListings());
    const result = await services.comparison.compareListings({
      items: ['111111111111', '222222222222'],
    });
    expect(result.disclaimer).toMatch(/no buy, bid or valuation recommendation/);
  });

  it('rejects a single item', async () => {
    const { services } = build();
    await expect(
      services.comparison.compareListings({ items: ['111111111111'] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('rejects more items than the configured maximum', async () => {
    const { services } = build({}, { EBAY_COMPARE_MAX_ITEMS: '2' });
    await expect(
      services.comparison.compareListings({
        items: ['111111111111', '222222222222', '333333333333'],
      }),
    ).rejects.toThrow(/at most 2 items/);
  });

  it('rejects the whole comparison when one reference is unparseable', async () => {
    const { services } = build();
    await expect(
      services.comparison.compareListings({ items: ['111111111111', 'not an ebay link'] }),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});
