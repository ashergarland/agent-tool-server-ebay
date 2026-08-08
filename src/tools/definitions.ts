import { z } from 'zod';
import { MARKETPLACE_IDS } from '../provider/ebay/marketplaces.js';
import type { Services } from '../services/index.js';
import { writable } from '../util/types.js';

export interface ToolInvocationContext {
  readonly requestId: string;
  readonly principal: string;
}

export type ToolKind = 'read' | 'write';

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  OutputSchema extends z.ZodType = z.ZodType,
> {
  readonly name: string;
  readonly title: string;
  /** One-line description surfaced in tool listings and the OpenAPI summary. */
  readonly summary: string;
  /** Full description used by the model to decide when the tool applies. */
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
  readonly handler: (
    input: z.output<InputSchema>,
    services: Services,
    context: ToolInvocationContext,
  ) => Promise<z.output<OutputSchema>>;
}

/** Identity helper that preserves the concrete schema types when declaring a tool. */
const defineTool = <InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(
  definition: ToolDefinition<InputSchema, OutputSchema>,
): ToolDefinition<InputSchema, OutputSchema> => definition;

/* ------------------------------------------------------------- input pieces */

const itemReference = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    'An eBay listing URL (https://www.ebay.com/itm/407111131587, with or without an SEO slug or ' +
      'query string, on any eBay country site), a bare numeric item id (407111131587), or a ' +
      'Browse API item id (v1|407111131587|0).',
  );

const marketplaceId = z
  .enum(MARKETPLACE_IDS)
  .describe(
    'eBay marketplace to query. Defaults to the marketplace implied by a supplied listing URL, ' +
      "otherwise the connector's configured default (usually EBAY_US).",
  );

const sort = z
  .enum(['bestMatch', 'newlyListed', 'priceAsc', 'priceDesc'])
  .default('bestMatch')
  .describe(
    "Result ordering. 'bestMatch' is eBay's relevance ranking; 'priceAsc' sorts by item price " +
      '(not delivered total), so compare estimatedDeliveredTotal yourself when shipping matters.',
  );

const searchLimit = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(20)
  .describe('Maximum listings to return. The connector clamps this to its configured maximum.');

const conditionsFilter = z
  .array(z.enum(['NEW', 'USED']))
  .max(2)
  .optional()
  .describe(
    "Broad condition filter. eBay's coarse filter only distinguishes NEW from USED; use " +
      'conditionIds for finer grades such as 3000 (Used) or 7000 (For parts or not working).',
  );

const conditionIdsFilter = z
  .array(z.string().regex(/^\d{1,6}$/))
  .max(10)
  .optional()
  .describe(
    'Precise eBay condition ids. Common values: 1000 New, 1500 New other/open box, 2000 ' +
      'Certified refurbished, 2500 Seller refurbished, 2750 Like new, 3000 Used, 4000 Very good, ' +
      '5000 Good, 6000 Acceptable, 7000 For parts or not working.',
  );

const countryCode = z
  .string()
  .regex(/^[A-Za-z]{2}$/, 'must be a two letter ISO 3166 country code')
  .describe('Two letter ISO 3166 country code, e.g. US or GB.');

/* ----------------------------------------------------------- output schemas */

const moneySchema = z
  .object({
    value: z.number().describe('Numeric amount.'),
    currency: z.string().describe('ISO 4217 currency code.'),
  })
  .describe('A monetary amount as reported by eBay.');

const sellerSchema = z.object({
  username: z.string().optional(),
  feedbackPercentage: z.number().optional().describe('Positive feedback percentage, e.g. 99.4.'),
  feedbackScore: z.number().optional().describe('Total feedback count.'),
  sellerAccountType: z.string().optional(),
});

const locationSchema = z.object({
  city: z.string().optional(),
  stateOrProvince: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

const shippingOptionSchema = z.object({
  type: z.string().optional(),
  serviceCode: z.string().optional(),
  carrierCode: z.string().optional(),
  costType: z.string().optional().describe("eBay's shipping cost type, e.g. FIXED or CALCULATED."),
  cost: moneySchema.optional(),
  additionalCostPerUnit: moneySchema.optional(),
  importCharges: moneySchema.optional(),
  fulfilledThrough: z.string().optional(),
  minEstimatedDeliveryDate: z.string().optional(),
  maxEstimatedDeliveryDate: z.string().optional(),
  freeShipping: z.boolean(),
});

const returnTermsSchema = z.object({
  returnsAccepted: z.boolean().optional(),
  returnPeriodDays: z.number().optional(),
  refundMethod: z.string().optional(),
  returnMethod: z.string().optional(),
  returnShippingCostPayer: z.string().optional(),
  restockingFeePercentage: z.string().optional(),
});

const availabilitySchema = z.object({
  status: z.string().optional().describe('IN_STOCK or OUT_OF_STOCK.'),
  availableQuantity: z.number().optional(),
  soldQuantity: z.number().optional(),
  threshold: z.number().optional(),
  thresholdType: z.string().optional(),
  deliveryOptions: z.array(z.string()),
});

const itemAspectSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const listingSchema = z
  .object({
    itemId: z.string().describe('Browse API item id, e.g. v1|407111131587|0.'),
    legacyItemId: z.string().optional().describe('Numeric eBay item id shown in listing URLs.'),
    title: z.string(),
    subtitle: z.string().optional(),
    shortDescription: z.string().optional(),
    itemWebUrl: z.string().optional().describe('Canonical eBay listing URL.'),
    itemAffiliateWebUrl: z.string().optional(),
    marketplaceId: z.string(),
    listingMarketplaceId: z.string().optional(),

    price: moneySchema.optional().describe('Buy It Now / start price.'),
    currentBidPrice: moneySchema.optional().describe('Current high bid, auctions only.'),
    minimumPriceToBid: moneySchema.optional(),
    unitPrice: moneySchema.optional(),
    unitPricingMeasure: z.string().optional(),
    originalPrice: moneySchema.optional().describe('Strike-through price when discounted.'),
    discountPercentage: z.string().optional(),

    buyingOptions: z.array(z.string()).describe('FIXED_PRICE, AUCTION, BEST_OFFER, CLASSIFIED_AD.'),
    isAuction: z.boolean(),
    isFixedPrice: z.boolean(),
    acceptsBestOffer: z.boolean(),
    bidCount: z.number().optional(),
    uniqueBidderCount: z.number().optional(),
    reservePriceMet: z.boolean().optional(),

    itemCreationDate: z.string().optional(),
    itemEndDate: z
      .string()
      .optional()
      .describe('ISO 8601 UTC end time; absent for most GTC listings.'),
    secondsRemaining: z
      .number()
      .optional()
      .describe('Seconds until itemEndDate. Negative once the listing has ended.'),
    ended: z.boolean(),
    availabilityStatus: z.string().optional(),
    active: z
      .boolean()
      .describe('False when the listing has ended or is out of stock; do not treat it as buyable.'),

    condition: z.string().optional(),
    conditionId: z.string().optional(),
    conditionDescription: z.string().optional().describe("The seller's free-text condition notes."),

    seller: sellerSchema,
    itemLocation: locationSchema,

    shippingOptions: z.array(shippingOptionSchema),
    lowestShippingCost: moneySchema.optional(),
    estimatedDeliveredTotal: moneySchema
      .optional()
      .describe(
        'Current price (or current bid for auctions) plus the cheapest known shipping option. ' +
          'Absent when eBay only quotes calculated shipping and no buyer location is configured.',
      ),
    shipsToCountries: z.array(z.string()),

    returnTerms: returnTermsSchema.optional(),
    availability: availabilitySchema.optional(),

    categoryId: z.string().optional(),
    categoryPath: z.string().optional().describe('Pipe separated category breadcrumb.'),
    categoryIdPath: z.string().optional(),
    leafCategoryIds: z.array(z.string()),

    itemSpecifics: z.array(itemAspectSchema).describe("eBay's structured item specifics."),
    productIdentifiers: z.object({
      epid: z.string().optional().describe('eBay catalogue product id.'),
      brand: z.string().optional(),
      mpn: z.string().optional(),
      gtin: z.string().optional(),
    }),

    imageUrl: z.string().optional(),
    additionalImageUrls: z.array(z.string()),

    topRatedBuyingExperience: z.boolean().optional(),
    qualifiedPrograms: z.array(z.string()).describe('e.g. AUTHENTICITY_GUARANTEE, EBAY_PLUS.'),
    adultOnly: z.boolean().optional(),
    lotSize: z.number().optional(),
    sellerItemRevision: z.string().optional(),
  })
  .describe('A normalised eBay listing.');

const listingSummarySchema = z
  .object({
    itemId: z.string(),
    legacyItemId: z.string().optional(),
    title: z.string(),
    itemWebUrl: z.string().optional(),
    itemAffiliateWebUrl: z.string().optional(),
    price: moneySchema.optional(),
    currentBidPrice: moneySchema.optional(),
    bidCount: z.number().optional(),
    buyingOptions: z.array(z.string()),
    isAuction: z.boolean(),
    isFixedPrice: z.boolean(),
    acceptsBestOffer: z.boolean(),
    condition: z.string().optional(),
    conditionId: z.string().optional(),
    seller: sellerSchema,
    itemLocation: locationSchema,
    lowestShippingCost: moneySchema.optional(),
    estimatedDeliveredTotal: moneySchema.optional(),
    itemCreationDate: z.string().optional(),
    itemEndDate: z.string().optional(),
    secondsRemaining: z.number().optional(),
    ended: z.boolean(),
    active: z.boolean(),
    categoryIds: z.array(z.string()),
    epid: z.string().optional(),
    imageUrl: z.string().optional(),
    marketplaceId: z.string(),
  })
  .describe('A normalised eBay search result row.');

const referenceSchema = z.object({
  legacyItemId: z.string().optional(),
  itemId: z.string().optional(),
  legacyVariationId: z.string().optional(),
  marketplaceId: z.string().optional(),
  sourceUrl: z.string().optional(),
});

/* -------------------------------------------------------------------- tools */

export const getListingTool = defineTool({
  name: 'ebay_get_listing',
  title: 'Get an eBay listing',
  summary: 'Retrieve one real eBay listing by URL or item id via the official eBay Browse API.',
  description:
    'Fetches the authoritative, structured data for a single eBay listing: price, current bid, ' +
    'shipping cost and estimated delivered total, auction status and time remaining, condition ' +
    "and the seller's condition notes, seller feedback, return policy, quantity, category, item " +
    'specifics and images. Use this whenever the user pastes an eBay link or item number — it ' +
    'returns the actual listing from eBay, not a web page guess. Only active-listing data is ' +
    'available; the connector cannot retrieve sold or completed prices.',
  kind: 'read',
  inputSchema: z.object({
    item: itemReference,
    marketplaceId: marketplaceId.optional(),
  }),
  outputSchema: z.object({
    listing: listingSchema,
    reference: referenceSchema,
  }),
  handler: async (input, services) => {
    const { listing, reference } = await services.listings.getListing({
      item: input.item,
      ...(input.marketplaceId === undefined ? {} : { marketplaceId: input.marketplaceId }),
    });
    return {
      listing: writable(listing),
      reference: {
        ...(reference.itemId === undefined ? {} : { itemId: reference.itemId }),
        ...(reference.legacyItemId === undefined ? {} : { legacyItemId: reference.legacyItemId }),
        ...(reference.legacyVariationId === undefined
          ? {}
          : { legacyVariationId: reference.legacyVariationId }),
        ...(reference.marketplaceId === undefined
          ? {}
          : { marketplaceId: reference.marketplaceId }),
        ...(reference.sourceUrl === undefined ? {} : { sourceUrl: reference.sourceUrl }),
      },
    };
  },
});

export const searchListingsTool = defineTool({
  name: 'ebay_search_listings',
  title: 'Search active eBay listings',
  summary: 'Search currently active eBay listings with structured filters.',
  description:
    'Structured keyword and filter search over **active** eBay listings using the official ' +
    'Browse API. Use it to survey what is on the market right now: current asking prices, ' +
    'auctions ending, condition mix and seller mix. Results never include sold or ended ' +
    'listings, so treat them as asking prices rather than realised prices. Every row reports ' +
    'whether it is still active.',
  kind: 'read',
  inputSchema: z.object({
    query: z
      .string()
      .min(1)
      .max(350)
      .optional()
      .describe(
        'Keywords, e.g. "sega saturn console japanese". Required unless categoryIds is set.',
      ),
    categoryIds: z
      .array(z.string().regex(/^\d{1,15}$/))
      .max(10)
      .optional()
      .describe('eBay category ids to restrict the search to.'),
    minPrice: z.number().min(0).max(1_000_000).optional().describe('Minimum item price.'),
    maxPrice: z.number().min(0).max(1_000_000).optional().describe('Maximum item price.'),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional()
      .describe('ISO 4217 currency for the price filter. Defaults to USD.'),
    conditions: conditionsFilter,
    conditionIds: conditionIdsFilter,
    auctionOnly: z.boolean().optional().describe('Return only auction listings.'),
    buyItNowOnly: z.boolean().optional().describe('Return only fixed-price listings.'),
    acceptsBestOfferOnly: z.boolean().optional().describe('Return only listings accepting offers.'),
    freeShippingOnly: z.boolean().optional().describe('Return only listings with free delivery.'),
    returnsAcceptedOnly: z
      .boolean()
      .optional()
      .describe('Return only listings that accept returns.'),
    itemLocationCountry: countryCode.optional().describe('Country the item is located in.'),
    deliveryCountry: countryCode.optional().describe('Country the buyer wants delivery to.'),
    deliveryPostalCode: z
      .string()
      .max(20)
      .optional()
      .describe('Buyer postal code; improves shipping-cost accuracy. Requires deliveryCountry.'),
    sellers: z
      .array(z.string().max(64))
      .max(20)
      .optional()
      .describe('Restrict to these eBay seller usernames.'),
    excludeSellers: z.array(z.string().max(64)).max(20).optional(),
    excludeCategoryIds: z
      .array(z.string().regex(/^\d{1,15}$/))
      .max(10)
      .optional(),
    searchInDescription: z
      .boolean()
      .optional()
      .describe('Also match the listing description, not just the title. Requires query.'),
    marketplaceId: marketplaceId.optional(),
    sort,
    limit: searchLimit,
    offset: z.number().int().min(0).max(1000).default(0).describe('Pagination offset.'),
  }),
  outputSchema: z.object({
    listings: z.array(listingSummarySchema),
    total: z.number().optional().describe('Total matches eBay reports, which may exceed limit.'),
    limit: z.number(),
    offset: z.number(),
    appliedQuery: z.string().optional(),
    appliedFilter: z.string().optional().describe('The eBay filter expression actually sent.'),
    warnings: z.array(z.string()),
    activeOnly: z
      .boolean()
      .describe('Always true: the eBay Browse API only exposes currently active listings.'),
  }),
  handler: async (input, services) => {
    const result = await services.listings.searchListings(input);
    return {
      listings: writable(result.listings),
      ...(result.total === undefined ? {} : { total: result.total }),
      limit: result.limit,
      offset: result.offset,
      ...(result.appliedQuery === undefined ? {} : { appliedQuery: result.appliedQuery }),
      ...(result.appliedFilter === undefined ? {} : { appliedFilter: result.appliedFilter }),
      warnings: [...result.warnings],
      activeOnly: true,
    };
  },
});

export const findSimilarListingsTool = defineTool({
  name: 'ebay_find_similar_listings',
  title: 'Find comparable active listings',
  summary: 'Given one eBay listing, find comparable listings currently on the market.',
  description:
    'Takes an eBay listing URL or item id, derives a search strategy from that listing (its ' +
    'catalogue product id, GTIN or MPN where eBay has one, otherwise its distilled title ' +
    'keywords, category and identifying item specifics) and returns comparable **active** ' +
    'listings. Use it to establish what similar items are currently asking. The returned ' +
    'strategy and query tell you how the comparables were found, so you can judge how tight the ' +
    'match is. These are asking prices, not sold prices.',
  kind: 'read',
  inputSchema: z.object({
    item: itemReference,
    marketplaceId: marketplaceId.optional(),
    matchCondition: z
      .boolean()
      .default(false)
      .describe('Restrict comparables to the same broad condition (new vs used) as the source.'),
    sameCategoryOnly: z
      .boolean()
      .default(true)
      .describe("Restrict comparables to the source listing's eBay category."),
    auctionOnly: z.boolean().optional(),
    buyItNowOnly: z.boolean().optional(),
    sort,
    limit: searchLimit,
  }),
  outputSchema: z.object({
    source: listingSchema,
    strategy: z
      .enum(['epid', 'gtin', 'mpn', 'keywords'])
      .describe('How comparables were found, most precise (epid) to loosest (keywords).'),
    appliedQuery: z.string().optional(),
    appliedFilter: z.string().optional(),
    comparables: z.array(listingSummarySchema),
    totalMatches: z.number().optional(),
    notes: z.array(z.string()),
    activeOnly: z.boolean(),
  }),
  handler: async (input, services) => {
    const result = await services.comparison.findSimilarListings(input);
    return {
      source: writable(result.source),
      strategy: result.strategy,
      ...(result.appliedQuery === undefined ? {} : { appliedQuery: result.appliedQuery }),
      ...(result.appliedFilter === undefined ? {} : { appliedFilter: result.appliedFilter }),
      comparables: writable(result.comparables),
      ...(result.totalMatches === undefined ? {} : { totalMatches: result.totalMatches }),
      notes: [...result.notes],
      activeOnly: true,
    };
  },
});

export const compareListingsTool = defineTool({
  name: 'ebay_compare_listings',
  title: 'Compare eBay listings',
  summary: 'Fetch several eBay listings and report them side by side with their differences.',
  description:
    'Accepts two or more eBay listing URLs or item ids, fetches each one from the official ' +
    'Browse API and returns a normalised side-by-side comparison: item price, shipping, ' +
    'estimated delivered total, condition and condition notes, buying format, bid count and ' +
    'auction end, seller reputation, return terms, location, item specifics and images, plus a ' +
    'plain-language list of what actually differs. The connector supplies data only and makes ' +
    'no buy or bid recommendation.',
  kind: 'read',
  inputSchema: z.object({
    items: z
      .array(itemReference)
      .min(2)
      .max(20)
      .describe('Two or more eBay listing URLs or item ids to compare.'),
    marketplaceId: marketplaceId.optional(),
  }),
  outputSchema: z.object({
    listings: z.array(
      z.object({
        itemId: z.string(),
        legacyItemId: z.string().optional(),
        title: z.string(),
        url: z.string().optional(),
        marketplaceId: z.string(),
        price: moneySchema.optional(),
        currentBidPrice: moneySchema.optional(),
        lowestShippingCost: moneySchema.optional(),
        estimatedDeliveredTotal: moneySchema.optional(),
        buyingOptions: z.array(z.string()),
        isAuction: z.boolean(),
        acceptsBestOffer: z.boolean(),
        bidCount: z.number().optional(),
        itemEndDate: z.string().optional(),
        secondsRemaining: z.number().optional(),
        active: z.boolean(),
        condition: z.string().optional(),
        conditionId: z.string().optional(),
        conditionDescription: z.string().optional(),
        sellerUsername: z.string().optional(),
        sellerFeedbackPercentage: z.number().optional(),
        sellerFeedbackScore: z.number().optional(),
        itemLocation: locationSchema,
        returnsAccepted: z.boolean().optional(),
        returnPeriodDays: z.number().optional(),
        itemSpecifics: z.array(itemAspectSchema),
        imageUrl: z.string().optional(),
        additionalImageUrls: z.array(z.string()),
      }),
    ),
    differences: z.array(z.string()).describe('Plain-language description of what varies.'),
    unavailableCount: z
      .number()
      .describe('How many of the compared listings are no longer active.'),
    disclaimer: z.string(),
  }),
  handler: async (input, services) => {
    const result = await services.comparison.compareListings(input);
    return {
      listings: writable(result.listings),
      differences: [...result.differences],
      unavailableCount: result.unavailableCount,
      disclaimer: result.disclaimer,
    };
  },
});

export const toolDefinitions = [
  getListingTool,
  searchListingsTool,
  findSimilarListingsTool,
  compareListingsTool,
] as const satisfies readonly ToolDefinition[];
