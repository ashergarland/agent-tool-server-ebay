import { describe, expect, it } from 'vitest';
import { buildSearchFilter, toEbaySort } from '../../src/provider/ebay/filters.js';
import { Guardrails } from '../../src/services/guardrails.js';
import { testConfig } from '../helpers/config.js';

describe('buildSearchFilter', () => {
  it('produces no filter when nothing is constrained', () => {
    expect(buildSearchFilter({}).filter).toBeUndefined();
  });

  it('emits a bounded price range with the required currency', () => {
    expect(buildSearchFilter({ minPrice: 10, maxPrice: 50 }).filter).toBe(
      'price:[10..50],priceCurrency:USD',
    );
  });

  it('emits an open-ended minimum', () => {
    expect(buildSearchFilter({ minPrice: 10 }).filter).toBe('price:[10],priceCurrency:USD');
  });

  it('emits an open-ended maximum', () => {
    expect(buildSearchFilter({ maxPrice: 50 }).filter).toBe('price:[..50],priceCurrency:USD');
  });

  it('honours an explicit currency', () => {
    expect(buildSearchFilter({ maxPrice: 50, currency: 'gbp' }).filter).toContain(
      'priceCurrency:GBP',
    );
  });

  it('rounds prices to cents so eBay never sees float noise', () => {
    expect(buildSearchFilter({ maxPrice: 19.999 }).filter).toBe('price:[..20],priceCurrency:USD');
  });

  it('rejects an inverted price range', () => {
    expect(() => buildSearchFilter({ minPrice: 100, maxPrice: 10 })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('rejects a malformed currency', () => {
    expect(() => buildSearchFilter({ maxPrice: 10, currency: 'dollars' })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('emits set syntax for conditions and condition ids', () => {
    expect(buildSearchFilter({ conditions: ['NEW', 'USED'] }).filter).toBe('conditions:{NEW|USED}');
    expect(buildSearchFilter({ conditionIds: ['3000', '7000'] }).filter).toBe(
      'conditionIds:{3000|7000}',
    );
  });

  it('rejects a non numeric condition id', () => {
    expect(() => buildSearchFilter({ conditionIds: ['USED'] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('emits buying options', () => {
    expect(buildSearchFilter({ buyingOptions: ['AUCTION'] }).filter).toBe(
      'buyingOptions:{AUCTION}',
    );
  });

  it('emits location filters', () => {
    expect(
      buildSearchFilter({
        itemLocationCountry: 'us',
        deliveryCountry: 'gb',
        deliveryPostalCode: 'SW1A 1AA',
      }).filter,
    ).toBe('itemLocationCountry:US,deliveryCountry:GB,deliveryPostalCode:SW1A 1AA');
  });

  it('rejects a postal code with no delivery country', () => {
    expect(() => buildSearchFilter({ deliveryPostalCode: '19406' })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('rejects a postal code containing filter delimiters', () => {
    expect(() =>
      buildSearchFilter({ deliveryCountry: 'US', deliveryPostalCode: '19406,price:[0]' }),
    ).toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('uses the only value eBay accepts for free shipping', () => {
    expect(buildSearchFilter({ freeShippingOnly: true }).filter).toBe('maxDeliveryCost:0');
  });

  it('uses the only value eBay accepts for returns', () => {
    expect(buildSearchFilter({ returnsAcceptedOnly: true }).filter).toBe('returnsAccepted:true');
  });

  it('emits seller include and exclude sets', () => {
    expect(buildSearchFilter({ sellers: ['a_seller'], excludeSellers: ['b_seller'] }).filter).toBe(
      'sellers:{a_seller},excludeSellers:{b_seller}',
    );
  });

  it('rejects a seller name that could inject filter syntax', () => {
    expect(() => buildSearchFilter({ sellers: ['evil},price:[0..1'] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('requires a keyword query for searchInDescription', () => {
    expect(() => buildSearchFilter({ searchInDescription: true })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
    expect(buildSearchFilter({ query: 'saturn', searchInDescription: true }).filter).toBe(
      'searchInDescription:true',
    );
  });

  it('passes category ids, epid and gtin as query parameters not filters', () => {
    const built = buildSearchFilter({
      categoryIds: ['139971', '1249'],
      epid: '2296658',
      gtin: '4974365801007',
    });
    expect(built.filter).toBeUndefined();
    expect(built.params).toMatchObject({
      category_ids: '139971,1249',
      epid: '2296658',
      gtin: '4974365801007',
    });
  });

  it('rejects a non numeric category id', () => {
    expect(() => buildSearchFilter({ categoryIds: ['electronics'] })).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('joins several clauses with commas', () => {
    expect(
      buildSearchFilter({
        minPrice: 10,
        conditions: ['USED'],
        buyingOptions: ['AUCTION'],
        returnsAcceptedOnly: true,
      }).filter,
    ).toBe(
      'price:[10],priceCurrency:USD,conditions:{USED},buyingOptions:{AUCTION},returnsAccepted:true',
    );
  });
});

describe('toEbaySort', () => {
  it('maps the connector sorts to the values eBay documents', () => {
    expect(toEbaySort('bestMatch')).toBeUndefined();
    expect(toEbaySort('newlyListed')).toBe('newlyListed');
    expect(toEbaySort('priceAsc')).toBe('price');
    expect(toEbaySort('priceDesc')).toBe('-price');
  });
});

describe('Guardrails', () => {
  const guardrails = new Guardrails(testConfig());

  it('exposes the configured defaults', () => {
    expect(guardrails.defaultMarketplaceId).toBe('EBAY_US');
    expect(guardrails.searchDefaultLimit).toBe(20);
    expect(guardrails.searchMaxLimit).toBe(50);
    expect(guardrails.compareMaxItems).toBe(8);
  });

  it('accepts a supported marketplace', () => {
    expect(guardrails.assertMarketplaceSupported('EBAY_GB')).toBe('EBAY_GB');
  });

  it('rejects a marketplace the Buy APIs do not support', () => {
    expect(() => guardrails.assertMarketplaceSupported('EBAY_IN')).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('lists the supported marketplaces in the error details', () => {
    try {
      guardrails.assertMarketplaceSupported('EBAY_NOPE');
      expect.unreachable();
    } catch (error) {
      expect(
        (error as { details: { supportedMarketplaceIds: string[] } }).details
          .supportedMarketplaceIds,
      ).toContain('EBAY_US');
    }
  });

  it('falls back to the default limit', () => {
    expect(guardrails.resolveLimit(undefined)).toBe(20);
  });

  it('clamps an oversized limit', () => {
    expect(guardrails.resolveLimit(500)).toBe(50);
  });

  it('honours a smaller requested limit', () => {
    expect(guardrails.resolveLimit(3)).toBe(3);
  });

  it('rejects a non positive or fractional limit', () => {
    expect(() => guardrails.resolveLimit(0)).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
    expect(() => guardrails.resolveLimit(2.5)).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('requires at least two items to compare', () => {
    expect(() => guardrails.assertCompareSize(1)).toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('rejects more items than the configured maximum', () => {
    expect(() => guardrails.assertCompareSize(9)).toThrow(/at most 8 items/);
  });

  it('accepts a compare request at the boundary', () => {
    expect(() => guardrails.assertCompareSize(8)).not.toThrow();
  });

  it('exposes the configured default buyer location', () => {
    const configured = new Guardrails(
      testConfig({ EBAY_DELIVERY_COUNTRY: 'US', EBAY_DELIVERY_POSTAL_CODE: '19406' }),
    );
    expect(configured.defaultDeliveryCountry).toBe('US');
    expect(configured.defaultDeliveryPostalCode).toBe('19406');
  });
});
