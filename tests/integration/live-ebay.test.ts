import { describe, expect, it } from 'vitest';
import { createEbayProvider } from '../../src/provider/ebay/index.js';
import { loadConfig } from '../../src/config/index.js';

/**
 * Opt-in smoke test against the real eBay API.
 *
 * It is skipped unless EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are present in the environment, so
 * the default test suite never needs live credentials and never makes a network call. Run it with
 * real sandbox or production credentials when validating a deployment:
 *
 *   EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... EBAY_LIVE_TESTS=1 npm test
 */
const enabled =
  process.env['EBAY_LIVE_TESTS'] === '1' &&
  Boolean(process.env['EBAY_CLIENT_ID']) &&
  Boolean(process.env['EBAY_CLIENT_SECRET']);

describe.skipIf(!enabled)('live eBay Browse API', () => {
  const provider = () =>
    createEbayProvider(
      loadConfig({ ...process.env, NODE_ENV: 'development', AUTH_MODE: 'disabled' }),
    );

  it('authenticates and searches', async () => {
    const result = await provider().searchListings({
      marketplaceId: 'EBAY_US',
      query: 'sega saturn console',
      sort: 'bestMatch',
      limit: 3,
      offset: 0,
    });

    expect(result.listings.length).toBeGreaterThan(0);
    expect(result.listings[0]?.title).toBeTypeOf('string');
  }, 30_000);

  it('retrieves a listing returned by search', async () => {
    const client = provider();
    const search = await client.searchListings({
      marketplaceId: 'EBAY_US',
      query: 'nintendo 64 console',
      sort: 'bestMatch',
      limit: 1,
      offset: 0,
    });

    const first = search.listings[0];
    expect(first).toBeDefined();

    const listing = await client.getListing({
      marketplaceId: 'EBAY_US',
      itemId: first?.itemId ?? '',
    });
    expect(listing.itemId).toBe(first?.itemId);
  }, 30_000);
});
