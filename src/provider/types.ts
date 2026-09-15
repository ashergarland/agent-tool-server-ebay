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

export type FulfillmentType = 'SHIPPING' | 'LOCAL_PICKUP';

/**
 * One way a buyer can receive the item. A listing may expose several at once — shipped delivery
 * *and* free local pickup is common — so these are never mutually exclusive.
 */
export interface FulfillmentOption {
  readonly type: FulfillmentType;
  /** False when eBay offers the method but not to the requested destination. */
  readonly available: boolean;
  /** The cost of this method. Zero for local pickup; absent when eBay quoted no price. */
  readonly shippingCost?: Money | undefined;
  /** False when eBay exposes the method without a price (typically calculated shipping). */
  readonly shippingCostKnown: boolean;
  /** True when supplying a buyer country/postal code would let eBay quote the price. */
  readonly shippingCostRequiresLocation: boolean;
  readonly serviceName?: string | undefined;
  readonly serviceCode?: string | undefined;
  readonly carrierCode?: string | undefined;
  readonly costType?: string | undefined;
  readonly fulfilledThrough?: string | undefined;
  readonly importCharges?: Money | undefined;
  readonly additionalCostPerUnit?: Money | undefined;
  readonly minEstimatedDeliveryDate?: string | undefined;
  readonly maxEstimatedDeliveryDate?: string | undefined;
  readonly unavailableReason?: 'DESTINATION_NOT_SERVED' | undefined;
  /** The payload field this option was recovered from, for diagnostics. */
  readonly source?: string | undefined;
}

/** Why the connector classified a listing's shipping the way it did. */
export type FulfillmentClassification =
  | 'SHIPPING_COST_KNOWN'
  /** Shippable, but eBay needs more of the buyer's location before it will quote a price. */
  | 'SHIPPING_COST_REQUIRES_LOCATION'
  /** Shippable, the destination was fully supplied, and eBay still withheld the price. */
  | 'SHIPPING_COST_UNKNOWN'
  /** eBay offers shipping, but not to the requested destination. */
  | 'SHIPPING_UNAVAILABLE_TO_DESTINATION'
  | 'LOCAL_PICKUP_ONLY'
  | 'NO_FULFILLMENT_DATA';

export interface FulfillmentDiagnostics {
  readonly sourceFields: readonly string[];
  readonly deliveryOptionEnums: readonly string[];
  readonly pickupOptionsPresent: boolean;
  readonly destinationCountrySupplied: boolean;
  readonly destinationPostalCodeSupplied: boolean;
  readonly shipToLocationsEvaluated: boolean;
  readonly destinationExcludedByShipToLocations: boolean;
  readonly shippingOptionCount: number;
  readonly localPickupOptionCount: number;
  readonly classification: FulfillmentClassification;
}

/** The derived, caller-facing view of a listing's fulfillment methods. */
export interface FulfillmentSummary {
  readonly fulfillmentOptions: readonly FulfillmentOption[];
  readonly shippingAvailable: boolean;
  readonly localPickupAvailable: boolean;
  /** True only when there is no shippable option for the requested destination. */
  readonly localPickupOnly: boolean;
  /** Cheapest known *shipped* cost; never the zero cost of a local pickup. */
  readonly shippingCost: Money | undefined;
  readonly shippingCostKnown: boolean;
  readonly shippingCostRequiresLocation: boolean;
  readonly minEstimatedDeliveryDate: string | undefined;
  readonly maxEstimatedDeliveryDate: string | undefined;
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
  /** Parent item group id when this listing is one variation of a multi-variation group. */
  readonly itemGroupId: string | undefined;
  /** eBay's item group type, currently only `SELLER_DEFINED_VARIATIONS`. */
  readonly itemGroupType: string | undefined;
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
  /**
   * Every fulfillment method eBay exposes for the listing. Shipping and local pickup coexist here;
   * `localPickupOnly` is true only when no shippable option exists for the requested destination.
   */
  readonly fulfillmentOptions: readonly FulfillmentOption[];
  readonly shippingAvailable: boolean;
  readonly localPickupAvailable: boolean;
  readonly localPickupOnly: boolean;
  /** Cheapest known shipped-delivery cost; local pickup's zero cost is never used here. */
  readonly shippingCost: Money | undefined;
  readonly shippingCostKnown: boolean;
  readonly shippingCostRequiresLocation: boolean;
  readonly minEstimatedDeliveryDate: string | undefined;
  readonly maxEstimatedDeliveryDate: string | undefined;
  /** Alias of {@link shippingCost}, kept for backwards compatibility. */
  readonly lowestShippingCost: Money | undefined;
  /** Item price plus the cheapest shipped-delivery cost, when both are known and share a currency. */
  readonly estimatedDeliveredTotal: Money | undefined;
  readonly shipsToCountries: readonly string[];
  readonly fulfillmentDiagnostics: FulfillmentDiagnostics;

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
  /**
   * Item group id, present when this row is a multi-variation listing. Such a row describes a
   * group of purchasable variations, so it must be followed up with `getItemGroup` rather than
   * treated as one buyable item.
   */
  readonly itemGroupId: string | undefined;
  /** eBay's item group type (currently only `SELLER_DEFINED_VARIATIONS`); absent for single items. */
  readonly itemGroupType: string | undefined;
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
  readonly fulfillmentOptions: readonly FulfillmentOption[];
  readonly shippingAvailable: boolean;
  readonly localPickupAvailable: boolean;
  readonly localPickupOnly: boolean;
  readonly shippingCost: Money | undefined;
  readonly shippingCostKnown: boolean;
  readonly shippingCostRequiresLocation: boolean;
  readonly minEstimatedDeliveryDate: string | undefined;
  readonly maxEstimatedDeliveryDate: string | undefined;
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
  /** Buyer destination, so eBay quotes shipping for the right place. */
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  /** Browse item id (`v1|...|...`); preferred when the caller supplied one. */
  readonly itemId?: string | undefined;
  /** Numeric legacy item id; used when no Browse item id is available. */
  readonly legacyItemId?: string | undefined;
  readonly legacyVariationId?: string | undefined;
}

/**
 * One purchasable variation of a multi-variation listing. This is a projection of {@link Listing}:
 * the fields a buyer needs to tell variations apart and pick one, without repeating the group-wide
 * data on every row.
 */
export interface ItemGroupVariation {
  /** RESTful Browse item id (`v1|<groupId>|<variationId>`), usable directly with getItem. */
  readonly itemId: string;
  readonly legacyItemId: string | undefined;
  readonly title: string;
  readonly itemWebUrl: string | undefined;
  readonly price: Money | undefined;
  readonly currentBidPrice: Money | undefined;
  readonly buyingOptions: readonly BuyingOption[];
  readonly condition: string | undefined;
  readonly conditionId: string | undefined;
  /** The item specifics eBay returned for this variation, e.g. Colour: Blue, Size: XL. */
  readonly itemSpecifics: readonly ItemAspect[];
  readonly availability: Availability | undefined;
  readonly availabilityStatus: string | undefined;
  readonly active: boolean;
  readonly seller: SellerInfo;
  readonly shippingOptions: readonly ShippingOption[];
  readonly fulfillmentOptions: readonly FulfillmentOption[];
  readonly shippingAvailable: boolean;
  readonly localPickupAvailable: boolean;
  readonly localPickupOnly: boolean;
  readonly shippingCost: Money | undefined;
  readonly shippingCostKnown: boolean;
  readonly shippingCostRequiresLocation: boolean;
  readonly minEstimatedDeliveryDate: string | undefined;
  readonly maxEstimatedDeliveryDate: string | undefined;
  readonly lowestShippingCost: Money | undefined;
  readonly estimatedDeliveredTotal: Money | undefined;
  readonly imageUrl: string | undefined;
}

/** A multi-variation eBay listing as returned by `getItemsByItemGroup`. */
export interface ItemGroup {
  readonly itemGroupId: string;
  readonly itemGroupType: string | undefined;
  readonly title: string | undefined;
  readonly imageUrl: string | undefined;
  readonly marketplaceId: MarketplaceId;
  /** Every individually purchasable item in the group, in the order eBay returned them. */
  readonly items: readonly ItemGroupVariation[];
  /** Item specific names whose values differ between variations, e.g. ['Colour', 'Size']. */
  readonly varyingAspects: readonly string[];
  readonly warnings: readonly string[];
}

export interface GetItemGroupInput {
  readonly marketplaceId: MarketplaceId;
  readonly itemGroupId: string;
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
}

/**
 * The eBay port. Everything a service needs from eBay is expressed here; no other layer imports
 * anything from `provider/ebay`.
 */
export interface EbayProvider {
  getListing(input: GetListingInput): Promise<Listing>;
  getItemGroup(input: GetItemGroupInput): Promise<ItemGroup>;
  searchListings(input: SearchInput): Promise<SearchResult>;
}
