import type {
  EbayProvider,
  Listing,
  ListingSummary,
  MarketplaceId,
  SearchSort,
} from '../provider/types.js';
import type { Guardrails } from './guardrails.js';
import { buildSearchQuery, identifyingAspectValues, titleKeywords } from './keywords.js';
import type { ListingsService } from './listings.js';

export type SimilarSearchStrategy = 'epid' | 'gtin' | 'mpn' | 'keywords';

export interface FindSimilarRequest {
  readonly item: string;
  readonly marketplaceId?: string | undefined;
  readonly matchCondition?: boolean | undefined;
  readonly sameCategoryOnly?: boolean | undefined;
  readonly auctionOnly?: boolean | undefined;
  readonly buyItNowOnly?: boolean | undefined;
  readonly sort?: SearchSort | undefined;
  readonly limit?: number | undefined;
}

export interface FindSimilarResult {
  readonly source: Listing;
  readonly strategy: SimilarSearchStrategy;
  readonly appliedQuery: string | undefined;
  readonly appliedFilter: string | undefined;
  readonly comparables: readonly ListingSummary[];
  readonly totalMatches: number | undefined;
  readonly notes: readonly string[];
}

export interface CompareRequest {
  readonly items: readonly string[];
  readonly marketplaceId?: string | undefined;
}

export interface ComparisonRow {
  readonly itemId: string;
  readonly legacyItemId: string | undefined;
  readonly title: string;
  readonly url: string | undefined;
  readonly marketplaceId: MarketplaceId;
  readonly price: Listing['price'];
  readonly currentBidPrice: Listing['currentBidPrice'];
  readonly lowestShippingCost: Listing['lowestShippingCost'];
  readonly estimatedDeliveredTotal: Listing['estimatedDeliveredTotal'];
  readonly buyingOptions: readonly string[];
  readonly isAuction: boolean;
  readonly acceptsBestOffer: boolean;
  readonly bidCount: number | undefined;
  readonly itemEndDate: string | undefined;
  readonly secondsRemaining: number | undefined;
  readonly active: boolean;
  readonly condition: string | undefined;
  readonly conditionId: string | undefined;
  readonly conditionDescription: string | undefined;
  readonly sellerUsername: string | undefined;
  readonly sellerFeedbackPercentage: number | undefined;
  readonly sellerFeedbackScore: number | undefined;
  readonly itemLocation: Listing['itemLocation'];
  readonly returnsAccepted: boolean | undefined;
  readonly returnPeriodDays: number | undefined;
  readonly itemSpecifics: Listing['itemSpecifics'];
  readonly imageUrl: string | undefined;
  readonly additionalImageUrls: readonly string[];
}

export interface CompareResult {
  readonly listings: readonly ComparisonRow[];
  readonly differences: readonly string[];
  readonly unavailableCount: number;
  readonly disclaimer: string;
}

/**
 * Comparison of a single listing against the live market, and of several listings against each
 * other. The connector only ever supplies evidence — it deliberately produces no buy, bid or
 * price recommendation, because the valuation judgement belongs to the model and the user.
 */
const DISCLAIMER =
  'This is normalised eBay listing data only. It contains no buy, bid or valuation recommendation, ' +
  'and no sold or completed-listing history (see the connector README for that limitation).';

/** Number of extra rows fetched so the source listing can be dropped without shrinking results. */
const OVERFETCH = 3;

export class ComparisonService {
  public constructor(
    private readonly provider: EbayProvider,
    private readonly listings: ListingsService,
    private readonly guardrails: Guardrails,
  ) {}

  /**
   * Builds a search strategy from a listing's own identity. Catalogue identifiers (EPID, GTIN,
   * MPN) are preferred because they match the same product rather than the same words; a title
   * keyword search is the fallback for the long tail of uncatalogued collectibles.
   */
  public async findSimilarListings(request: FindSimilarRequest): Promise<FindSimilarResult> {
    const { listing } = await this.listings.getListing({
      item: request.item,
      ...(request.marketplaceId === undefined ? {} : { marketplaceId: request.marketplaceId }),
    });

    const marketplaceId = listing.marketplaceId;
    const limit = this.guardrails.resolveLimit(request.limit);
    const notes: string[] = [];

    const buyingOptions: ('AUCTION' | 'FIXED_PRICE')[] = [];
    if (request.auctionOnly) buyingOptions.push('AUCTION');
    if (request.buyItNowOnly) buyingOptions.push('FIXED_PRICE');

    const categoryIds =
      request.sameCategoryOnly === false
        ? undefined
        : (listing.categoryId ?? listing.leafCategoryIds[0]);

    const conditions = request.matchCondition ? conditionBucket(listing.conditionId) : undefined;
    if (request.matchCondition && !conditions) {
      notes.push(
        'The source listing has no condition id, so comparables were not filtered by condition.',
      );
    }

    const baseInput = {
      marketplaceId,
      ...(categoryIds ? { categoryIds: [categoryIds] } : {}),
      ...(conditions ? { conditions } : {}),
      ...(buyingOptions.length > 0 ? { buyingOptions } : {}),
      deliveryCountry: this.guardrails.defaultDeliveryCountry,
      deliveryPostalCode: this.guardrails.defaultDeliveryPostalCode,
      sort: request.sort ?? 'bestMatch',
      limit: Math.min(limit + OVERFETCH, this.guardrails.searchMaxLimit),
      offset: 0,
    } as const;

    for (const attempt of buildStrategies(listing)) {
      const result = await this.provider.searchListings({
        ...baseInput,
        ...(attempt.epid === undefined ? {} : { epid: attempt.epid }),
        ...(attempt.gtin === undefined ? {} : { gtin: attempt.gtin }),
        ...(attempt.query === undefined ? {} : { query: attempt.query }),
      });

      const comparables = result.listings
        .filter((candidate) => !isSameItem(candidate, listing))
        .slice(0, limit);

      if (comparables.length > 0 || attempt.strategy === 'keywords') {
        if (comparables.length === 0) {
          notes.push('eBay returned no active comparable listings for this item.');
        }
        return {
          source: listing,
          strategy: attempt.strategy,
          appliedQuery: result.appliedQuery,
          appliedFilter: result.appliedFilter,
          comparables,
          totalMatches: result.total,
          notes: [...notes, ...result.warnings],
        };
      }

      notes.push(
        `No active listings matched by ${attempt.strategy}; retried with a broader strategy.`,
      );
    }

    // buildStrategies always ends with a keyword attempt, so this is unreachable in practice.
    return {
      source: listing,
      strategy: 'keywords',
      appliedQuery: undefined,
      appliedFilter: undefined,
      comparables: [],
      totalMatches: 0,
      notes: [...notes, 'No search strategy could be derived from this listing.'],
    };
  }

  /** Fetches several listings and reports them side by side with their notable differences. */
  public async compareListings(request: CompareRequest): Promise<CompareResult> {
    this.guardrails.assertCompareSize(request.items.length);

    const resolved = await Promise.all(
      request.items.map((item) =>
        this.listings.getListing({
          item,
          ...(request.marketplaceId === undefined ? {} : { marketplaceId: request.marketplaceId }),
        }),
      ),
    );

    const rows = resolved.map(({ listing }) => toComparisonRow(listing));
    return {
      listings: rows,
      differences: describeDifferences(rows),
      unavailableCount: rows.filter((row) => !row.active).length,
      disclaimer: DISCLAIMER,
    };
  }
}

interface StrategyAttempt {
  readonly strategy: SimilarSearchStrategy;
  readonly epid?: string;
  readonly gtin?: string;
  readonly query?: string;
}

/** Ordered search attempts, most precise first, always ending with a keyword search. */
const buildStrategies = (listing: Listing): readonly StrategyAttempt[] => {
  const attempts: StrategyAttempt[] = [];
  const { epid, gtin, mpn, brand } = listing.productIdentifiers;

  if (epid) attempts.push({ strategy: 'epid', epid });
  if (gtin) attempts.push({ strategy: 'gtin', gtin });
  if (mpn) {
    attempts.push({ strategy: 'mpn', query: buildSearchQuery([brand ?? '', mpn]) });
  }

  const keywords = titleKeywords(listing.title);
  const aspects = identifyingAspectValues(listing.itemSpecifics, keywords);
  attempts.push({ strategy: 'keywords', query: buildSearchQuery([...keywords, ...aspects]) });

  return attempts;
};

/** eBay's `conditions` filter only distinguishes NEW from USED; ids below 2000 are new. */
const conditionBucket = (
  conditionId: string | undefined,
): readonly ['NEW' | 'USED'] | undefined => {
  if (!conditionId || !/^\d+$/.test(conditionId)) return undefined;
  return Number.parseInt(conditionId, 10) < 2000 ? (['NEW'] as const) : (['USED'] as const);
};

const isSameItem = (candidate: ListingSummary, listing: Listing): boolean =>
  candidate.itemId === listing.itemId ||
  (candidate.legacyItemId !== undefined && candidate.legacyItemId === listing.legacyItemId);

const toComparisonRow = (listing: Listing): ComparisonRow => ({
  itemId: listing.itemId,
  legacyItemId: listing.legacyItemId,
  title: listing.title,
  url: listing.itemWebUrl,
  marketplaceId: listing.marketplaceId,
  price: listing.price,
  currentBidPrice: listing.currentBidPrice,
  lowestShippingCost: listing.lowestShippingCost,
  estimatedDeliveredTotal: listing.estimatedDeliveredTotal,
  buyingOptions: listing.buyingOptions,
  isAuction: listing.isAuction,
  acceptsBestOffer: listing.acceptsBestOffer,
  bidCount: listing.bidCount,
  itemEndDate: listing.itemEndDate,
  secondsRemaining: listing.secondsRemaining,
  active: listing.active,
  condition: listing.condition,
  conditionId: listing.conditionId,
  conditionDescription: listing.conditionDescription,
  sellerUsername: listing.seller.username,
  sellerFeedbackPercentage: listing.seller.feedbackPercentage,
  sellerFeedbackScore: listing.seller.feedbackScore,
  itemLocation: listing.itemLocation,
  returnsAccepted: listing.returnTerms?.returnsAccepted,
  returnPeriodDays: listing.returnTerms?.returnPeriodDays,
  itemSpecifics: listing.itemSpecifics,
  imageUrl: listing.imageUrl,
  additionalImageUrls: listing.additionalImageUrls,
});

const distinct = <T>(values: readonly (T | undefined)[]): T[] => [
  ...new Set(values.filter((value): value is T => value !== undefined)),
];

const format = (money: { value: number; currency: string } | undefined): string | undefined =>
  money ? `${money.value.toFixed(2)} ${money.currency}` : undefined;

/**
 * Describes what actually varies across the compared listings, in plain language, so the model
 * does not have to re-derive it from the rows. Purely descriptive: no ranking, no advice.
 */
const describeDifferences = (rows: readonly ComparisonRow[]): readonly string[] => {
  const differences: string[] = [];

  const totals = rows
    .map((row) => row.estimatedDeliveredTotal)
    .filter((total): total is NonNullable<typeof total> => total !== undefined);
  const currencies = distinct(totals.map((total) => total.currency));

  if (totals.length >= 2 && currencies.length === 1) {
    const values = totals.map((total) => total.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    differences.push(
      max === min
        ? `All ${totals.length} listings with a known delivered total are ${format({ value: min, currency: currencies[0] ?? '' })}.`
        : `Estimated delivered totals range from ${format({ value: min, currency: currencies[0] ?? '' })} to ${format({ value: max, currency: currencies[0] ?? '' })}.`,
    );
  } else if (currencies.length > 1) {
    differences.push(
      `Listings are priced in different currencies (${currencies.join(', ')}), so totals are not directly comparable.`,
    );
  }
  if (totals.length < rows.length) {
    differences.push(
      `${rows.length - totals.length} of ${rows.length} listings do not expose a delivered total (usually calculated shipping without a buyer location).`,
    );
  }

  const conditions = distinct(rows.map((row) => row.condition));
  if (conditions.length > 1) {
    differences.push(`Conditions differ: ${conditions.join(', ')}.`);
  }

  const auctions = rows.filter((row) => row.isAuction).length;
  if (auctions > 0 && auctions < rows.length) {
    differences.push(
      `${auctions} of ${rows.length} listings are auctions; the remainder are fixed price.`,
    );
  }
  const bestOffers = rows.filter((row) => row.acceptsBestOffer).length;
  if (bestOffers > 0 && bestOffers < rows.length) {
    differences.push(`${bestOffers} of ${rows.length} listings accept Best Offer.`);
  }

  const returnsAccepted = rows.filter((row) => row.returnsAccepted === true).length;
  if (returnsAccepted > 0 && returnsAccepted < rows.length) {
    differences.push(`${returnsAccepted} of ${rows.length} sellers accept returns.`);
  }

  const feedback = rows
    .map((row) => row.sellerFeedbackPercentage)
    .filter((value): value is number => value !== undefined);
  if (feedback.length >= 2) {
    const min = Math.min(...feedback);
    const max = Math.max(...feedback);
    if (max - min >= 0.5) {
      differences.push(`Seller feedback ranges from ${min}% to ${max}%.`);
    }
  }

  const inactive = rows.filter((row) => !row.active);
  if (inactive.length > 0) {
    differences.push(
      `${inactive.length} of ${rows.length} listings are no longer active (ended or out of stock) and should not be treated as buying options.`,
    );
  }

  differences.push(...describeAspectDifferences(rows));
  return differences;
};

/** Reports item specifics that are present on every listing but hold different values. */
const describeAspectDifferences = (rows: readonly ComparisonRow[]): readonly string[] => {
  if (rows.length < 2) return [];

  const valuesByAspect = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const aspect of row.itemSpecifics) {
      const bucket = valuesByAspect.get(aspect.name) ?? new Set<string>();
      bucket.add(aspect.value);
      valuesByAspect.set(aspect.name, bucket);
    }
  }

  const differing: string[] = [];
  for (const [name, values] of valuesByAspect) {
    if (values.size > 1 && differing.length < 5) {
      differing.push(`${name}: ${[...values].join(' vs ')}`);
    }
  }

  return differing.length > 0 ? [`Item specifics that differ — ${differing.join('; ')}.`] : [];
};
