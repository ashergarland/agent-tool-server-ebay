import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { ItemGroupError } from '../../src/errors.js';
import { EbayShortLinkResolver } from '../../src/provider/ebay/short-links.js';
import type { GetListingInput } from '../../src/provider/types.js';
import { createServices } from '../../src/services/index.js';
import { testConfig } from '../helpers/config.js';
import { createFakeFetch } from '../helpers/fake-fetch.js';
import {
  createFakeProvider,
  createTestLogger,
  GROUP_ID,
  makeListing,
  type FakeProviderOptions,
} from '../helpers/fake-provider.js';

const SHORT_LINK = 'https://ebay.io/m/tPMNkN';
const LISTING_ID = '168601131927';

const build = (location: string, providerOptions: FakeProviderOptions = {}) => {
  const fetch = createFakeFetch([{ status: 301, headers: { location } }]);
  const provider = createFakeProvider(providerOptions);
  const services = createServices(
    testConfig(),
    provider,
    createTestLogger() as unknown as Logger,
    new EbayShortLinkResolver({ fetchImpl: fetch.fetchImpl }),
  );
  return { fetch, provider, services };
};

const providerCalls = (provider: ReturnType<typeof createFakeProvider>, name: string) =>
  provider.calls.filter((call) => call.name === name);

describe('listing-oriented services with eBay mobile share links', () => {
  it('resolves ebay.io to a normal listing URL before the Browse API lookup', async () => {
    const finalUrl = `https://www.ebay.com/itm/${LISTING_ID}?var=&mkevt=1&mkcid=16&mkrid=711-127632-2357-0`;
    const { fetch, provider, services } = build(finalUrl);

    const result = await services.listings.getListing({ item: SHORT_LINK });

    expect(fetch.requests).toHaveLength(1);
    expect(providerCalls(provider, 'getListing')[0]?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      legacyItemId: LISTING_ID,
    });
    expect(result.reference.sourceUrl).toBe(`https://www.ebay.com/itm/${LISTING_ID}`);
  });

  it('keeps normal URLs, numeric ids, and Browse ids on their existing lookup paths', async () => {
    const { fetch, provider, services } = build(`https://www.ebay.com/itm/${LISTING_ID}`);

    await services.listings.getListing({ item: 'https://www.ebay.com/itm/407111131587' });
    await services.listings.getListing({ item: '407111131587' });
    await services.listings.getListing({ item: 'v1|407111131587|0' });

    expect(fetch.requests).toHaveLength(0);
    expect(providerCalls(provider, 'getListing').map((call) => call.args[0])).toEqual([
      { marketplaceId: 'EBAY_US', legacyItemId: '407111131587' },
      { marketplaceId: 'EBAY_US', legacyItemId: '407111131587' },
      { marketplaceId: 'EBAY_US', itemId: 'v1|407111131587|0' },
    ]);
  });

  it('lets a resolved item-group parent follow the existing group fallback', async () => {
    const { provider, services } = build(`https://www.ebay.com/itm/${GROUP_ID}`, {
      listing: () => {
        throw new ItemGroupError(GROUP_ID);
      },
    });

    const result = await services.listings.resolveItem({ item: SHORT_LINK });

    expect(result.kind).toBe('itemGroup');
    expect(providerCalls(provider, 'getListing')[0]?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      legacyItemId: GROUP_ID,
    });
    expect(providerCalls(provider, 'getItemGroup')[0]?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemGroupId: GROUP_ID,
    });
  });

  it('accepts a mobile share link when finding similar listings', async () => {
    const { provider, services } = build(`https://www.ebay.com/itm/${LISTING_ID}`);

    await services.comparison.findSimilarListings({ item: SHORT_LINK });

    expect(providerCalls(provider, 'getListing')[0]?.args[0]).toMatchObject({
      legacyItemId: LISTING_ID,
    });
    expect(providerCalls(provider, 'searchListings')).toHaveLength(1);
  });

  it('accepts a mobile share link alongside existing ids in a comparison', async () => {
    const secondId = '222222222222';
    const { services } = build(`https://www.ebay.com/itm/${LISTING_ID}`, {
      listing: (input: GetListingInput) =>
        makeListing({
          itemId: `v1|${input.legacyItemId ?? 'unknown'}|0`,
          legacyItemId: input.legacyItemId,
        }),
    });

    const result = await services.comparison.compareListings({
      items: [SHORT_LINK, secondId],
    });

    expect(result.listings.map((listing) => listing.legacyItemId)).toEqual([LISTING_ID, secondId]);
  });

  it('also accepts a parent mobile share link in the direct item-group flow', async () => {
    const { provider, services } = build(`https://www.ebay.com/itm/${GROUP_ID}`);

    await services.listings.getItemGroup({ itemGroup: SHORT_LINK });

    expect(providerCalls(provider, 'getItemGroup')[0]?.args[0]).toEqual({
      marketplaceId: 'EBAY_US',
      itemGroupId: GROUP_ID,
    });
  });
});
