import { describe, expect, it } from 'vitest';
import {
  addMoney,
  lowestShippingCost,
  normaliseListing,
  normaliseListingSummary,
  secondsUntil,
  toMoney,
} from '../../src/provider/ebay/normalize.js';
import { normaliseTotal, normaliseWarnings } from '../../src/provider/ebay/normalize.js';

const NOW = Date.parse('2024-06-01T12:00:00.000Z');
const options = { marketplaceId: 'EBAY_US', nowMs: NOW } as const;

describe('money normalisation', () => {
  it('parses eBay string amounts into numbers', () => {
    expect(toMoney({ value: '12.34', currency: 'USD' })).toEqual({ value: 12.34, currency: 'USD' });
  });

  it('accepts an already-numeric amount', () => {
    expect(toMoney({ value: 5, currency: 'GBP' })).toEqual({ value: 5, currency: 'GBP' });
  });

  it('returns undefined for incomplete or malformed amounts', () => {
    expect(toMoney(undefined)).toBeUndefined();
    expect(toMoney({ value: '12.34' })).toBeUndefined();
    expect(toMoney({ currency: 'USD' })).toBeUndefined();
    expect(toMoney({ value: 'free', currency: 'USD' })).toBeUndefined();
    expect(toMoney('12.34')).toBeUndefined();
  });

  it('adds amounts of the same currency and rounds to cents', () => {
    expect(addMoney({ value: 0.1, currency: 'USD' }, { value: 0.2, currency: 'USD' })).toEqual({
      value: 0.3,
      currency: 'USD',
    });
  });

  it('refuses to add across currencies', () => {
    expect(addMoney({ value: 1, currency: 'USD' }, { value: 1, currency: 'EUR' })).toBeUndefined();
  });

  it('treats a missing second amount as zero but a missing first as unknown', () => {
    expect(addMoney({ value: 1, currency: 'USD' }, undefined)).toEqual({
      value: 1,
      currency: 'USD',
    });
    expect(addMoney(undefined, { value: 1, currency: 'USD' })).toBeUndefined();
  });
});

describe('shipping normalisation', () => {
  const listing = (shippingOptions: unknown): ReturnType<typeof normaliseListing> =>
    normaliseListing(
      { itemId: 'v1|1|0', price: { value: '100.00', currency: 'USD' }, shippingOptions },
      options,
    );

  it('marks a zero cost option as free shipping', () => {
    const result = listing([
      { shippingCost: { value: '0.00', currency: 'USD' }, shippingCostType: 'FIXED' },
    ]);
    expect(result.shippingOptions[0]?.freeShipping).toBe(true);
    expect(result.lowestShippingCost).toEqual({ value: 0, currency: 'USD' });
    expect(result.estimatedDeliveredTotal).toEqual({ value: 100, currency: 'USD' });
  });

  it('picks the cheapest known option', () => {
    const result = listing([
      { shippingCost: { value: '25.00', currency: 'USD' } },
      { shippingCost: { value: '9.99', currency: 'USD' } },
      { shippingCost: { value: '14.00', currency: 'USD' } },
    ]);
    expect(result.lowestShippingCost).toEqual({ value: 9.99, currency: 'USD' });
    expect(result.estimatedDeliveredTotal).toEqual({ value: 109.99, currency: 'USD' });
  });

  it('ignores calculated options with no cost rather than treating them as free', () => {
    const result = listing([{ shippingCostType: 'CALCULATED', type: 'Calculated' }]);
    expect(result.shippingOptions).toHaveLength(1);
    expect(result.shippingOptions[0]?.freeShipping).toBe(false);
    expect(result.lowestShippingCost).toBeUndefined();
    expect(result.estimatedDeliveredTotal).toBeUndefined();
  });

  it('does not build a delivered total across currencies', () => {
    const result = listing([{ shippingCost: { value: '5.00', currency: 'EUR' } }]);
    expect(result.estimatedDeliveredTotal).toBeUndefined();
  });

  it('keeps delivery estimates and carrier details', () => {
    const result = listing([
      {
        shippingCost: { value: '4.00', currency: 'USD' },
        shippingCarrierCode: 'USPS',
        shippingServiceCode: 'USPSGround',
        minEstimatedDeliveryDate: '2024-06-05T00:00:00.000Z',
        maxEstimatedDeliveryDate: '2024-06-09T00:00:00.000Z',
      },
    ]);
    expect(result.shippingOptions[0]).toMatchObject({
      carrierCode: 'USPS',
      serviceCode: 'USPSGround',
      minEstimatedDeliveryDate: '2024-06-05T00:00:00.000Z',
    });
  });

  it('bounds the number of shipping options retained', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      shippingCost: { value: String(index), currency: 'USD' },
    }));
    expect(listing(many).shippingOptions).toHaveLength(10);
  });

  it('finds no cheapest option in an empty list', () => {
    expect(lowestShippingCost([])).toBeUndefined();
  });
});

describe('listing normalisation', () => {
  const payload = {
    itemId: 'v1|407111131587|0',
    legacyItemId: '407111131587',
    title: 'Sega Saturn Console',
    subtitle: 'Japanese region',
    itemWebUrl: 'https://www.ebay.com/itm/407111131587',
    price: { value: '149.99', currency: 'USD' },
    buyingOptions: ['FIXED_PRICE', 'BEST_OFFER'],
    condition: 'Used',
    conditionId: '3000',
    conditionDescription: 'Tested, works perfectly.',
    seller: { username: 'retro', feedbackPercentage: '99.3', feedbackScore: 812 },
    itemLocation: { city: 'Tokyo', country: 'JP' },
    shippingOptions: [{ shippingCost: { value: '20.00', currency: 'USD' } }],
    shipToLocations: { regionIncluded: [{ regionName: 'Worldwide' }] },
    returnTerms: {
      returnsAccepted: true,
      returnPeriod: { value: 30, unit: 'CALENDAR_DAY' },
      returnShippingCostPayer: 'BUYER',
    },
    estimatedAvailabilities: [
      {
        estimatedAvailabilityStatus: 'IN_STOCK',
        estimatedAvailableQuantity: 1,
        estimatedSoldQuantity: 4,
        deliveryOptions: ['SHIP_TO_HOME'],
      },
    ],
    categoryId: '139971',
    categoryPath: 'Video Games & Consoles|Video Game Consoles',
    leafCategoryIds: ['139971'],
    localizedAspects: [
      { type: 'STRING', name: 'Brand', value: 'Sega' },
      { type: 'STRING', name: 'Platform', value: 'Sega Saturn' },
    ],
    product: { brand: 'Sega', mpns: ['MK-80200'], gtins: ['4974365801007'] },
    epid: '2296658',
    image: { imageUrl: 'https://i.ebayimg.com/a.jpg' },
    additionalImages: [{ imageUrl: 'https://i.ebayimg.com/b.jpg' }],
    marketingPrice: {
      originalPrice: { value: '199.99', currency: 'USD' },
      discountPercentage: '25',
    },
    qualifiedPrograms: ['EBAY_PLUS'],
    topRatedBuyingExperience: true,
  };

  const listing = normaliseListing(payload, options);

  it('maps identity and pricing', () => {
    expect(listing).toMatchObject({
      itemId: 'v1|407111131587|0',
      legacyItemId: '407111131587',
      title: 'Sega Saturn Console',
      subtitle: 'Japanese region',
      marketplaceId: 'EBAY_US',
      price: { value: 149.99, currency: 'USD' },
      originalPrice: { value: 199.99, currency: 'USD' },
      discountPercentage: '25',
    });
  });

  it('derives buying format booleans from buyingOptions', () => {
    expect(listing).toMatchObject({
      isFixedPrice: true,
      isAuction: false,
      acceptsBestOffer: true,
    });
  });

  it('computes the estimated delivered total', () => {
    expect(listing.estimatedDeliveredTotal).toEqual({ value: 169.99, currency: 'USD' });
  });

  it('parses the seller feedback percentage from its string form', () => {
    expect(listing.seller).toMatchObject({ feedbackPercentage: 99.3, feedbackScore: 812 });
  });

  it('maps return terms including the return period in days', () => {
    expect(listing.returnTerms).toMatchObject({ returnsAccepted: true, returnPeriodDays: 30 });
  });

  it('takes the first estimated availability entry', () => {
    expect(listing.availability).toMatchObject({
      status: 'IN_STOCK',
      availableQuantity: 1,
      soldQuantity: 4,
    });
  });

  it('maps localizedAspects to item specifics', () => {
    expect(listing.itemSpecifics).toEqual([
      { name: 'Brand', value: 'Sega' },
      { name: 'Platform', value: 'Sega Saturn' },
    ]);
  });

  it('reads product identifiers from both scalar and container fields', () => {
    expect(listing.productIdentifiers).toEqual({
      epid: '2296658',
      brand: 'Sega',
      mpn: 'MK-80200',
      gtin: '4974365801007',
    });
  });

  it('maps images and ship-to regions', () => {
    expect(listing.imageUrl).toBe('https://i.ebayimg.com/a.jpg');
    expect(listing.additionalImageUrls).toEqual(['https://i.ebayimg.com/b.jpg']);
    expect(listing.shipsToCountries).toEqual(['Worldwide']);
  });

  it('survives a completely empty payload', () => {
    const empty = normaliseListing({}, options);
    expect(empty.title).toBe('(untitled listing)');
    expect(empty.buyingOptions).toEqual([]);
    expect(empty.active).toBe(true);
  });

  it('survives a non-object payload', () => {
    expect(normaliseListing(null, options).itemId).toBe('');
  });

  it('synthesises a Browse item id when only the legacy id is present', () => {
    expect(normaliseListing({ legacyItemId: '407111131587' }, options).itemId).toBe(
      'v1|407111131587|0',
    );
  });

  it('bounds the number of item specifics retained', () => {
    const many = Array.from({ length: 200 }, (_, index) => ({
      name: `Aspect ${index}`,
      value: 'x',
    }));
    expect(normaliseListing({ localizedAspects: many }, options).itemSpecifics).toHaveLength(60);
  });
});

describe('auction and availability', () => {
  it('prefers the current bid over the start price for the delivered total', () => {
    const listing = normaliseListing(
      {
        buyingOptions: ['AUCTION'],
        price: { value: '0.99', currency: 'USD' },
        currentBidPrice: { value: '45.00', currency: 'USD' },
        bidCount: 12,
        itemEndDate: '2024-06-01T18:00:00.000Z',
        shippingOptions: [{ shippingCost: { value: '10.00', currency: 'USD' } }],
      },
      options,
    );
    expect(listing).toMatchObject({
      isAuction: true,
      bidCount: 12,
      estimatedDeliveredTotal: { value: 55, currency: 'USD' },
    });
  });

  it('reports seconds remaining for a live auction', () => {
    const listing = normaliseListing({ itemEndDate: '2024-06-01T13:00:00.000Z' }, options);
    expect(listing.secondsRemaining).toBe(3600);
    expect(listing.ended).toBe(false);
    expect(listing.active).toBe(true);
  });

  it('marks a listing whose end date has passed as ended and inactive', () => {
    const listing = normaliseListing({ itemEndDate: '2024-05-31T12:00:00.000Z' }, options);
    expect(listing.secondsRemaining).toBe(-86_400);
    expect(listing.ended).toBe(true);
    expect(listing.active).toBe(false);
  });

  it('marks an out of stock listing as inactive without marking it ended', () => {
    const listing = normaliseListing(
      { estimatedAvailabilities: [{ estimatedAvailabilityStatus: 'OUT_OF_STOCK' }] },
      options,
    );
    expect(listing.ended).toBe(false);
    expect(listing.active).toBe(false);
  });

  it('treats a listing with no end date as active', () => {
    const listing = normaliseListing({ title: 'GTC listing' }, options);
    expect(listing.secondsRemaining).toBeUndefined();
    expect(listing.ended).toBe(false);
    expect(listing.active).toBe(true);
  });

  it('ignores an unparseable end date', () => {
    expect(secondsUntil('not-a-date', NOW)).toBeUndefined();
    expect(secondsUntil(undefined, NOW)).toBeUndefined();
  });
});

describe('search summary normalisation', () => {
  const summary = normaliseListingSummary(
    {
      itemId: 'v1|111111111111|0',
      legacyItemId: '111111111111',
      title: 'Nintendo 64 Console',
      price: { value: '89.00', currency: 'USD' },
      buyingOptions: ['AUCTION'],
      currentBidPrice: { value: '55.00', currency: 'USD' },
      bidCount: 3,
      itemEndDate: '2024-06-02T12:00:00.000Z',
      shippingOptions: [{ shippingCost: { value: '11.00', currency: 'USD' } }],
      categories: [{ categoryId: '139971' }, { categoryId: '1249' }],
      thumbnailImages: [{ imageUrl: 'https://i.ebayimg.com/thumb.jpg' }],
      seller: { username: 'n64shop', feedbackPercentage: '100.0' },
    },
    options,
  );

  it('normalises the auction fields', () => {
    expect(summary).toMatchObject({
      isAuction: true,
      bidCount: 3,
      currentBidPrice: { value: 55, currency: 'USD' },
      estimatedDeliveredTotal: { value: 66, currency: 'USD' },
      secondsRemaining: 86_400,
      active: true,
    });
  });

  it('collects unique category ids', () => {
    expect(summary.categoryIds).toEqual(['139971', '1249']);
  });

  it('falls back to a thumbnail when there is no primary image', () => {
    expect(summary.imageUrl).toBe('https://i.ebayimg.com/thumb.jpg');
  });

  it('marks an ended summary row as inactive', () => {
    const ended = normaliseListingSummary({ itemEndDate: '2024-05-01T00:00:00.000Z' }, options);
    expect(ended.active).toBe(false);
    expect(ended.ended).toBe(true);
  });
});

describe('envelope helpers', () => {
  it('extracts warning messages', () => {
    expect(
      normaliseWarnings({ warnings: [{ message: 'short', longMessage: 'a longer explanation' }] }),
    ).toEqual(['a longer explanation']);
  });

  it('falls back to the short message', () => {
    expect(normaliseWarnings({ warnings: [{ message: 'short' }] })).toEqual(['short']);
  });

  it('returns an empty list when there are no warnings', () => {
    expect(normaliseWarnings({})).toEqual([]);
    expect(normaliseWarnings(undefined)).toEqual([]);
  });

  it('reads the total match count', () => {
    expect(normaliseTotal({ total: 1234 })).toBe(1234);
    expect(normaliseTotal({})).toBeUndefined();
  });
});
