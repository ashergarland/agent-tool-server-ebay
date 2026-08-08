import { vi } from 'vitest';
import type {
  EbayProvider,
  GetListingInput,
  Listing,
  ListingSummary,
  SearchInput,
  SearchResult,
} from '../../src/provider/types.js';

export const LEGACY_ID = '407111131587';
export const BROWSE_ID = `v1|${LEGACY_ID}|0`;

/** A fully populated listing, used as the base for every fake provider response. */
export const makeListing = (overrides: Partial<Listing> = {}): Listing => ({
  itemId: BROWSE_ID,
  legacyItemId: LEGACY_ID,
  title: 'Sony PlayStation 2 Slim Console SCPH-70012 Charcoal Black',
  subtitle: undefined,
  shortDescription: undefined,
  itemWebUrl: `https://www.ebay.com/itm/${LEGACY_ID}`,
  itemAffiliateWebUrl: undefined,
  marketplaceId: 'EBAY_US',
  listingMarketplaceId: 'EBAY_US',

  price: { value: 89.99, currency: 'USD' },
  currentBidPrice: undefined,
  minimumPriceToBid: undefined,
  unitPrice: undefined,
  unitPricingMeasure: undefined,
  originalPrice: undefined,
  discountPercentage: undefined,

  buyingOptions: ['FIXED_PRICE'],
  isAuction: false,
  isFixedPrice: true,
  acceptsBestOffer: false,
  bidCount: undefined,
  uniqueBidderCount: undefined,
  reservePriceMet: undefined,

  itemCreationDate: '2024-01-02T03:04:05.000Z',
  itemEndDate: undefined,
  secondsRemaining: undefined,
  ended: false,
  availabilityStatus: 'IN_STOCK',
  active: true,

  condition: 'Used',
  conditionId: '3000',
  conditionDescription: 'Tested and working. Light scuffs on the shell.',

  seller: {
    username: 'retro_seller',
    feedbackPercentage: 99.4,
    feedbackScore: 1523,
    sellerAccountType: 'BUSINESS',
  },
  itemLocation: {
    city: 'Portland',
    stateOrProvince: 'OR',
    postalCode: '972**',
    country: 'US',
  },

  shippingOptions: [
    {
      type: 'Standard Shipping',
      serviceCode: 'USPSGround',
      carrierCode: 'USPS',
      costType: 'FIXED',
      cost: { value: 12.5, currency: 'USD' },
      additionalCostPerUnit: undefined,
      importCharges: undefined,
      fulfilledThrough: undefined,
      minEstimatedDeliveryDate: '2024-01-08T00:00:00.000Z',
      maxEstimatedDeliveryDate: '2024-01-12T00:00:00.000Z',
      freeShipping: false,
    },
  ],
  lowestShippingCost: { value: 12.5, currency: 'USD' },
  estimatedDeliveredTotal: { value: 102.49, currency: 'USD' },
  shipsToCountries: ['United States', 'Canada'],

  returnTerms: {
    returnsAccepted: true,
    returnPeriodDays: 30,
    refundMethod: 'MONEY_BACK',
    returnMethod: undefined,
    returnShippingCostPayer: 'BUYER',
    restockingFeePercentage: undefined,
  },
  availability: {
    status: 'IN_STOCK',
    availableQuantity: 1,
    soldQuantity: 0,
    threshold: undefined,
    thresholdType: undefined,
    deliveryOptions: ['SHIP_TO_HOME'],
  },

  categoryId: '139971',
  categoryPath: 'Video Games & Consoles|Video Game Consoles',
  categoryIdPath: '1249|139971',
  leafCategoryIds: ['139971'],

  itemSpecifics: [
    { name: 'Brand', value: 'Sony' },
    { name: 'Platform', value: 'Sony PlayStation 2' },
    { name: 'Model', value: 'SCPH-70012' },
  ],
  productIdentifiers: {
    epid: undefined,
    brand: 'Sony',
    mpn: undefined,
    gtin: undefined,
  },

  imageUrl: 'https://i.ebayimg.com/images/g/abc/s-l1600.jpg',
  additionalImageUrls: ['https://i.ebayimg.com/images/g/def/s-l1600.jpg'],

  topRatedBuyingExperience: true,
  qualifiedPrograms: ['EBAY_PLUS'],
  adultOnly: false,
  lotSize: undefined,
  sellerItemRevision: '3',
  ...overrides,
});

export const makeSummary = (overrides: Partial<ListingSummary> = {}): ListingSummary => ({
  itemId: 'v1|123456789012|0',
  legacyItemId: '123456789012',
  title: 'Sony PlayStation 2 Slim Console',
  itemWebUrl: 'https://www.ebay.com/itm/123456789012',
  itemAffiliateWebUrl: undefined,
  price: { value: 79.99, currency: 'USD' },
  currentBidPrice: undefined,
  bidCount: undefined,
  buyingOptions: ['FIXED_PRICE'],
  isAuction: false,
  isFixedPrice: true,
  acceptsBestOffer: false,
  condition: 'Used',
  conditionId: '3000',
  seller: {
    username: 'other_seller',
    feedbackPercentage: 98.1,
    feedbackScore: 402,
    sellerAccountType: undefined,
  },
  itemLocation: {
    city: 'Austin',
    stateOrProvince: 'TX',
    postalCode: '787**',
    country: 'US',
  },
  lowestShippingCost: { value: 9.99, currency: 'USD' },
  estimatedDeliveredTotal: { value: 89.98, currency: 'USD' },
  itemCreationDate: '2024-01-01T00:00:00.000Z',
  itemEndDate: undefined,
  secondsRemaining: undefined,
  ended: false,
  active: true,
  categoryIds: ['139971'],
  epid: undefined,
  imageUrl: 'https://i.ebayimg.com/images/g/xyz/s-l1600.jpg',
  marketplaceId: 'EBAY_US',
  ...overrides,
});

export interface RecordedCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface FakeProvider extends EbayProvider {
  readonly calls: RecordedCall[];
}

export interface FakeProviderOptions {
  readonly listing?: Listing | ((input: GetListingInput) => Listing);
  readonly search?: Partial<SearchResult> | ((input: SearchInput) => Partial<SearchResult>);
}

/**
 * Hand-written fake provider. Tests assert on the recorded calls, which keeps them honest about
 * what the connector would actually send to eBay. No network and no credentials are involved.
 */
export const createFakeProvider = (options: FakeProviderOptions = {}): FakeProvider => {
  const calls: RecordedCall[] = [];

  return {
    calls,
    getListing(input: GetListingInput): Promise<Listing> {
      calls.push({ name: 'getListing', args: [input] });
      const listing =
        typeof options.listing === 'function'
          ? options.listing(input)
          : (options.listing ?? makeListing({ marketplaceId: input.marketplaceId }));
      return Promise.resolve(listing);
    },
    searchListings(input: SearchInput): Promise<SearchResult> {
      calls.push({ name: 'searchListings', args: [input] });
      const overrides =
        typeof options.search === 'function' ? options.search(input) : (options.search ?? {});
      return Promise.resolve({
        listings: [makeSummary({ marketplaceId: input.marketplaceId })],
        total: 1,
        limit: input.limit,
        offset: input.offset,
        appliedFilter: undefined,
        appliedQuery: input.query,
        warnings: [],
        ...overrides,
      });
    },
  };
};

/** Minimal pino-compatible logger that swallows output during tests. */
export const createTestLogger = () => {
  const logger = {
    level: 'silent',
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
};
