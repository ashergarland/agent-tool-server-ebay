import { badRequest } from '../errors.js';
import type {
  EbayProvider,
  Listing,
  MarketplaceId,
  SearchResult,
  SearchSort,
} from '../provider/types.js';
import {
  parseItemReference,
  resolveMarketplace,
  type ItemReference,
} from '../provider/ebay/index.js';
import type { Guardrails } from './guardrails.js';

export interface GetListingRequest {
  readonly item: string;
  readonly marketplaceId?: string | undefined;
}

export interface SearchListingsRequest {
  readonly query?: string | undefined;
  readonly categoryIds?: readonly string[] | undefined;
  readonly minPrice?: number | undefined;
  readonly maxPrice?: number | undefined;
  readonly currency?: string | undefined;
  readonly conditions?: readonly ('NEW' | 'USED')[] | undefined;
  readonly conditionIds?: readonly string[] | undefined;
  readonly auctionOnly?: boolean | undefined;
  readonly buyItNowOnly?: boolean | undefined;
  readonly acceptsBestOfferOnly?: boolean | undefined;
  readonly freeShippingOnly?: boolean | undefined;
  readonly returnsAcceptedOnly?: boolean | undefined;
  readonly itemLocationCountry?: string | undefined;
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  readonly sellers?: readonly string[] | undefined;
  readonly excludeSellers?: readonly string[] | undefined;
  readonly excludeCategoryIds?: readonly string[] | undefined;
  readonly searchInDescription?: boolean | undefined;
  readonly marketplaceId?: string | undefined;
  readonly sort?: SearchSort | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ResolvedListing {
  readonly listing: Listing;
  readonly reference: ItemReference;
}

/**
 * Read-only listing retrieval and search. This layer owns the translation from "whatever the user
 * pasted" to a Browse API call, and the policy decisions (marketplace resolution, result caps,
 * mutually exclusive filters) that must not live in a transport.
 */
export class ListingsService {
  public constructor(
    private readonly provider: EbayProvider,
    private readonly guardrails: Guardrails,
  ) {}

  /** Resolves a caller-supplied marketplace string, falling back to the pasted URL's site. */
  public resolveMarketplaceFor(
    requested: string | undefined,
    reference?: ItemReference,
  ): MarketplaceId {
    const explicit =
      requested === undefined ? undefined : this.guardrails.assertMarketplaceSupported(requested);
    return resolveMarketplace(explicit, reference, this.guardrails.defaultMarketplaceId);
  }

  /**
   * Fetches one listing. A Browse item id is used when the caller supplied one; otherwise the
   * legacy-id endpoint is used, which is what a pasted `/itm/<id>` URL yields.
   */
  public async getListing(request: GetListingRequest): Promise<ResolvedListing> {
    const reference = parseItemReference(request.item);
    if (reference.kind === 'product') {
      throw badRequest(
        'That URL is an eBay catalogue product page, not a single listing, so it has no price, ' +
          'seller or condition of its own. Use searchListings or findSimilarListings with the ' +
          `product id (EPID ${reference.epid ?? 'unknown'}) to find the actual listings for it.`,
        { epid: reference.epid },
      );
    }

    const marketplaceId = this.resolveMarketplaceFor(request.marketplaceId, reference);
    const listing = await this.provider.getListing({
      marketplaceId,
      ...(reference.legacyItemId === undefined
        ? { itemId: reference.itemId }
        : {
            legacyItemId: reference.legacyItemId,
            ...(reference.legacyVariationId === undefined
              ? {}
              : { legacyVariationId: reference.legacyVariationId }),
          }),
    });

    return { listing, reference };
  }

  /** Structured search over active eBay listings. */
  public async searchListings(request: SearchListingsRequest): Promise<SearchResult> {
    if (request.auctionOnly && request.buyItNowOnly) {
      throw badRequest('auctionOnly and buyItNowOnly cannot both be true.');
    }

    const buyingOptions: ('AUCTION' | 'FIXED_PRICE' | 'BEST_OFFER')[] = [];
    if (request.auctionOnly) buyingOptions.push('AUCTION');
    if (request.buyItNowOnly) buyingOptions.push('FIXED_PRICE');
    if (request.acceptsBestOfferOnly) buyingOptions.push('BEST_OFFER');

    const marketplaceId = this.resolveMarketplaceFor(request.marketplaceId);
    const deliveryCountry = request.deliveryCountry ?? this.guardrails.defaultDeliveryCountry;
    const deliveryPostalCode =
      request.deliveryPostalCode ??
      (request.deliveryCountry === undefined
        ? this.guardrails.defaultDeliveryPostalCode
        : undefined);

    return this.provider.searchListings({
      marketplaceId,
      query: request.query,
      categoryIds: request.categoryIds,
      minPrice: request.minPrice,
      maxPrice: request.maxPrice,
      currency: request.currency,
      conditions: request.conditions,
      conditionIds: request.conditionIds,
      ...(buyingOptions.length > 0 ? { buyingOptions } : {}),
      itemLocationCountry: request.itemLocationCountry,
      deliveryCountry,
      deliveryPostalCode,
      freeShippingOnly: request.freeShippingOnly,
      returnsAcceptedOnly: request.returnsAcceptedOnly,
      sellers: request.sellers,
      excludeSellers: request.excludeSellers,
      excludeCategoryIds: request.excludeCategoryIds,
      searchInDescription: request.searchInDescription,
      sort: request.sort ?? 'bestMatch',
      limit: this.guardrails.resolveLimit(request.limit),
      offset: request.offset ?? 0,
    });
  }
}
