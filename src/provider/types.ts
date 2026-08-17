import type { MarketplaceId } from './ebay/marketplaces.js';

/**
 * The provider port. Services depend on this interface only, which keeps eBay REST payload shapes
 * out of the business layer and makes the whole tool surface testable with a fake provider.
 *
 * The types below are the connector's *normalised* view of an eBay listing. They are deliberately
 * lossy in one direction only: provider fields that help ChatGPT reason about a buy/bid decision
 * are kept, raw payload noise (HATEOAS links, marketing containers, EU compliance blobs) is not.
 */

export type { MarketplaceId };

/** A monetary amount as eBay reports it, plus a parsed numeric form for arithmetic. */
export interface Money {
  readonly value: number;
  readonly currency: string;
}

export type BuyingOption = 'FIXED_PRICE' | 'AUCTION' | 'BEST_OFFER' | 'CLASSIFIED_AD';

export interface SellerInfo {
  readonly username: string | undefined;
  readonly feedbackPercentage: number | undefined;
  readonly feedbackScore: number | undefined;
  readonly sellerAccountType: string | undefined;
}

export interface LocationInfo {
  readonly city: string | undefined;
  readonly stateOrProvince: string | undefined;
  readonly postalCode: string | undefined;
  readonly country: string | undefined;
}

export interface ShippingOption {
  readonly type: string | undefined;
  readonly serviceCode: string | undefined;
  readonly carrierCode: string | undefined;
  readonly costType: string | undefined;
  readonly cost: Money | undefined;
  readonly additionalCostPerUnit: Money | undefined;
  readonly importCharges: Money | undefined;
  readonly fulfilledThrough: string | undefined;
  readonly minEstimatedDeliveryDate: string | undefined;
  readonly maxEstimatedDeliveryDate: string | undefined;
  readonly freeShipping: boolean;
}

export interface ReturnTerms {
  readonly returnsAccepted: boolean | undefined;
  readonly returnPeriodDays: number | undefined;
  readonly refundMethod: string | undefined;
  readonly returnMethod: string | undefined;
  readonly returnShippingCostPayer: string | undefined;
  readonly restockingFeePercentage: string | undefined;
}

export interface Availability {
  readonly status: string | undefined;
  readonly availableQuantity: number | undefined;
  /** Browse API estimatedSoldQuantity for this active listing, when eBay returns it. */
  readonly soldQuantity: number | undefined;
  readonly threshold: number | undefined;
  readonly thresholdType: string | undefined;
  readonly deliveryOptions: readonly string[];
}

export interface ItemAspect {
  readonly name: string;
  readonly value: string;
}

export interface ProductIdentifiers {
  readonly epid: string | undefined;
  readonly brand: string | undefined;
  readonly mpn: string | undefined;
  readonly gtin: string | undefined;
}

/** The connector's normalised view of a single eBay listing. */
export interface Listing {
  readonly itemId: string;
  readonly legacyItemId: string | undefined;
  readonly title: string;
  readonly subtitle: string | undefined;
  readonly shortDescription: string | undefined;
  readonly itemWebUrl: string | undefined;
  readonly itemAffiliateWebUrl: string | undefined;
  readonly marketplaceId: MarketplaceId;
  readonly listingMarketplaceId: string | undefined;

  readonly price: Money | undefined;
  readonly currentBidPrice: Money | undefined;
  readonly minimumPriceToBid: Money | undefined;
  readonly unitPrice: Money | undefined;
  readonly unitPricingMeasure: string | undefined;
  readonly originalPrice: Money | undefined;
  readonly discountPercentage: string | undefined;

  readonly buyingOptions: readonly BuyingOption[];
  readonly isAuction: boolean;
  readonly isFixedPrice: boolean;
  readonly acceptsBestOffer: boolean;
  readonly bidCount: number | undefined;
  readonly uniqueBidderCount: number | undefined;
  readonly reservePriceMet: boolean | undefined;

  readonly itemCreationDate: string | undefined;
  readonly itemEndDate: string | undefined;
  /** Seconds until `itemEndDate`; negative once the listing has ended, undefined for no end date. */
  readonly secondsRemaining: number | undefined;
  readonly ended: boolean;
  readonly availabilityStatus: string | undefined;
  /** True when the listing is still purchasable: not ended and not out of stock. */
  readonly active: boolean;

  readonly condition: string | undefined;
  readonly conditionId: string | undefined;
  readonly conditionDescription: string | undefined;

  readonly seller: SellerInfo;
  readonly itemLocation: LocationInfo;

  readonly shippingOptions: readonly ShippingOption[];
  readonly lowestShippingCost: Money | undefined;
  /** Item price plus the cheapest shipping option, when both are known and share a currency. */
  readonly estimatedDeliveredTotal: Money | undefined;
  readonly shipsToCountries: readonly string[];

  readonly returnTerms: ReturnTerms | undefined;
  readonly availability: Availability | undefined;

  readonly categoryId: string | undefined;
  readonly categoryPath: string | undefined;
  readonly categoryIdPath: string | undefined;
  readonly leafCategoryIds: readonly string[];

  readonly itemSpecifics: readonly ItemAspect[];
  readonly productIdentifiers: ProductIdentifiers;

  readonly imageUrl: string | undefined;
  readonly additionalImageUrls: readonly string[];

  readonly topRatedBuyingExperience: boolean | undefined;
  readonly qualifiedPrograms: readonly string[];
  readonly adultOnly: boolean | undefined;
  readonly lotSize: number | undefined;
  readonly sellerItemRevision: string | undefined;
}

/** The lighter projection eBay returns from `item_summary/search`. */
export interface ListingSummary {
  readonly itemId: string;
  readonly legacyItemId: string | undefined;
  readonly title: string;
  readonly itemWebUrl: string | undefined;
  readonly itemAffiliateWebUrl: string | undefined;
  readonly price: Money | undefined;
  readonly currentBidPrice: Money | undefined;
  readonly bidCount: number | undefined;
  readonly buyingOptions: readonly BuyingOption[];
  readonly isAuction: boolean;
  readonly isFixedPrice: boolean;
  readonly acceptsBestOffer: boolean;
  readonly condition: string | undefined;
  readonly conditionId: string | undefined;
  readonly seller: SellerInfo;
  readonly itemLocation: LocationInfo;
  readonly lowestShippingCost: Money | undefined;
  readonly estimatedDeliveredTotal: Money | undefined;
  readonly itemCreationDate: string | undefined;
  readonly itemEndDate: string | undefined;
  readonly secondsRemaining: number | undefined;
  readonly ended: boolean;
  readonly active: boolean;
  readonly categoryIds: readonly string[];
  readonly epid: string | undefined;
  readonly imageUrl: string | undefined;
  readonly marketplaceId: MarketplaceId;
}

export type SearchSort = 'bestMatch' | 'newlyListed' | 'priceAsc' | 'priceDesc';

export interface SearchFilters {
  readonly query?: string | undefined;
  readonly categoryIds?: readonly string[] | undefined;
  readonly epid?: string | undefined;
  readonly gtin?: string | undefined;
  readonly minPrice?: number | undefined;
  readonly maxPrice?: number | undefined;
  readonly currency?: string | undefined;
  readonly conditions?: readonly ('NEW' | 'USED')[] | undefined;
  readonly conditionIds?: readonly string[] | undefined;
  readonly buyingOptions?: readonly BuyingOption[] | undefined;
  readonly itemLocationCountry?: string | undefined;
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  readonly freeShippingOnly?: boolean | undefined;
  readonly returnsAcceptedOnly?: boolean | undefined;
  readonly sellers?: readonly string[] | undefined;
  readonly excludeSellers?: readonly string[] | undefined;
  readonly excludeCategoryIds?: readonly string[] | undefined;
  readonly searchInDescription?: boolean | undefined;
  readonly aspectFilter?: string | undefined;
}

export interface SearchInput extends SearchFilters {
  readonly marketplaceId: MarketplaceId;
  readonly sort: SearchSort;
  readonly limit: number;
  readonly offset: number;
}

export interface SearchResult {
  readonly listings: readonly ListingSummary[];
  readonly total: number | undefined;
  readonly limit: number;
  readonly offset: number;
  /** The `filter` expression actually sent to eBay, echoed back so results are explainable. */
  readonly appliedFilter: string | undefined;
  readonly appliedQuery: string | undefined;
  readonly warnings: readonly string[];
}

export interface GetListingInput {
  readonly marketplaceId: MarketplaceId;
  /** Browse item id (`v1|...|...`); preferred when the caller supplied one. */
  readonly itemId?: string | undefined;
  /** Numeric legacy item id; used when no Browse item id is available. */
  readonly legacyItemId?: string | undefined;
  readonly legacyVariationId?: string | undefined;
}

/**
 * The eBay port. Everything a service needs from eBay is expressed here; no other layer imports
 * anything from `provider/ebay`.
 */
export interface EbayProvider {
  getListing(input: GetListingInput): Promise<Listing>;
  searchListings(input: SearchInput): Promise<SearchResult>;
}
