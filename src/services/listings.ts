import { badRequest, isItemGroupError } from '../errors.js';
import type {
  EbayProvider,
  GetListingInput,
  ItemGroup,
  Listing,
  MarketplaceId,
  SearchResult,
  SearchSort,
} from '../provider/types.js';
import {
  parseItemGroupReference,
  parseItemReference,
  resolveMarketplace,
  type ItemReferenceResolver,
  type ItemGroupReference,
  type ItemReference,
} from '../provider/ebay/index.js';
import type { Guardrails } from './guardrails.js';

export interface GetListingRequest {
  readonly item: string;
  readonly marketplaceId?: string | undefined;
  /** Buyer destination; eBay needs it to quote calculated shipping and delivery estimates. */
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
}

export interface GetItemGroupRequest {
  readonly itemGroup: string;
  readonly marketplaceId?: string | undefined;
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
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

export interface ResolvedItemGroup {
  readonly itemGroup: ItemGroup;
  readonly reference: ItemGroupReference;
}

/**
 * What a caller-supplied item reference turned out to be. eBay only reveals that a numeric id is a
 * variation parent when the lookup fails, so the answer is discriminated rather than assumed.
 */
export type ResolvedItemReference =
  | { readonly kind: 'listing'; readonly listing: Listing; readonly reference: ItemReference }
  | {
      readonly kind: 'itemGroup';
      readonly itemGroup: ItemGroup;
      readonly reference: ItemReference;
    };

/**
 * Read-only listing retrieval and search. This layer owns the translation from "whatever the user
 * pasted" to a Browse API call, and the policy decisions (marketplace resolution, result caps,
 * mutually exclusive filters) that must not live in a transport.
 */
export class ListingsService {
  public constructor(
    private readonly provider: EbayProvider,
    private readonly guardrails: Guardrails,
    private readonly itemReferenceResolver: ItemReferenceResolver,
  ) {}

  /** Resolves a caller-supplied marketplace string, falling back to the pasted URL's site. */
  public resolveMarketplaceFor(
    requested: string | undefined,
    reference?: { readonly marketplaceId: MarketplaceId | undefined },
  ): MarketplaceId {
    const explicit =
      requested === undefined ? undefined : this.guardrails.assertMarketplaceSupported(requested);
    return resolveMarketplace(explicit, reference, this.guardrails.defaultMarketplaceId);
  }

  /**
   * Fetches one listing.
   *
   * Identifier routing follows eBay's documented model: a Browse item id (`v1|...|...`) is a
   * RESTful identifier and is passed straight to `GET /item/{item_id}`; a legacy site id — which
   * is what a pasted `/itm/<id>` URL yields — goes to `getItemByLegacyId`. The two id spaces are
   * not interchangeable, so a caller-supplied Browse id is never rewritten into a legacy lookup.
   *
   * Throws an `ItemGroupError` when the id turns out to identify a multi-variation group; callers
   * that want the group resolved for them should use {@link resolveItem}.
   */
  public async getListing(request: GetListingRequest): Promise<ResolvedListing> {
    const { reference, marketplaceId } = await this.resolveReference(request);
    const listing = await this.provider.getListing(
      this.toGetListingInput(reference, marketplaceId, this.resolveDestination(request)),
    );
    return { listing, reference };
  }

  /**
   * Resolves whatever the caller pasted: a single listing, or — when eBay reports that the id is a
   * variation parent — the item group itself. The group is fetched through the documented
   * `getItemsByItemGroup` endpoint so the caller receives every purchasable variation instead of
   * an arbitrarily chosen one.
   */
  public async resolveItem(request: GetListingRequest): Promise<ResolvedItemReference> {
    const { reference, marketplaceId } = await this.resolveReference(request);
    const destination = this.resolveDestination(request);

    try {
      const listing = await this.provider.getListing(
        this.toGetListingInput(reference, marketplaceId, destination),
      );
      return { kind: 'listing', listing, reference };
    } catch (error) {
      // Only eBay can tell us the id was a group, and only by failing the single-item lookup.
      if (!isItemGroupError(error) || error.itemGroupId === undefined) throw error;

      const itemGroup = await this.provider.getItemGroup({
        marketplaceId,
        itemGroupId: error.itemGroupId,
        ...destination,
      });
      return { kind: 'itemGroup', itemGroup, reference };
    }
  }

  /** Parses the caller's item reference and settles the marketplace to query it on. */
  private async resolveReference(request: GetListingRequest): Promise<{
    reference: ItemReference;
    marketplaceId: MarketplaceId;
  }> {
    const resolvedItem = await this.itemReferenceResolver.resolve(request.item);
    const reference = parseItemReference(resolvedItem);
    if (reference.kind === 'product') {
      throw badRequest(
        'That URL is an eBay catalogue product page, not a single listing, so it has no price, ' +
          'seller or condition of its own. Use searchListings or findSimilarListings with the ' +
          `product id (EPID ${reference.epid ?? 'unknown'}) to find the actual listings for it.`,
        { epid: reference.epid },
      );
    }
    return {
      reference,
      marketplaceId: this.resolveMarketplaceFor(request.marketplaceId, reference),
    };
  }

  /**
   * The destination to quote shipping for: whatever the caller asked for, else the deployment
   * default. A caller-supplied country without a postal code intentionally drops the default
   * postal code, which belongs to a different place.
   */
  private resolveDestination(request: {
    readonly deliveryCountry?: string | undefined;
    readonly deliveryPostalCode?: string | undefined;
  }): { deliveryCountry: string | undefined; deliveryPostalCode: string | undefined } {
    return {
      deliveryCountry: request.deliveryCountry ?? this.guardrails.defaultDeliveryCountry,
      deliveryPostalCode:
        request.deliveryPostalCode ??
        (request.deliveryCountry === undefined
          ? this.guardrails.defaultDeliveryPostalCode
          : undefined),
    };
  }

  private toGetListingInput(
    reference: ItemReference,
    marketplaceId: MarketplaceId,
    destination: { deliveryCountry: string | undefined; deliveryPostalCode: string | undefined },
  ): GetListingInput {
    return {
      marketplaceId,
      ...destination,
      ...(reference.browseItemIdSupplied || reference.legacyItemId === undefined
        ? { itemId: reference.itemId }
        : {
            legacyItemId: reference.legacyItemId,
            ...(reference.legacyVariationId === undefined
              ? {}
              : { legacyVariationId: reference.legacyVariationId }),
          }),
    };
  }

  /** Retrieves every purchasable variation of a multi-variation listing. */
  public async getItemGroup(request: GetItemGroupRequest): Promise<ResolvedItemGroup> {
    const resolvedItemGroup = await this.itemReferenceResolver.resolve(request.itemGroup);
    const reference = parseItemGroupReference(resolvedItemGroup);
    const marketplaceId = this.resolveMarketplaceFor(request.marketplaceId, reference);
    const itemGroup = await this.provider.getItemGroup({
      marketplaceId,
      itemGroupId: reference.itemGroupId,
      ...this.resolveDestination(request),
    });
    return { itemGroup, reference };
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
    const { deliveryCountry, deliveryPostalCode } = this.resolveDestination(request);

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
