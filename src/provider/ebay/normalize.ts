import type {
  Availability,
  BuyingOption,
  ItemAspect,
  Listing,
  ListingSummary,
  LocationInfo,
  MarketplaceId,
  Money,
  ProductIdentifiers,
  ReturnTerms,
  SellerInfo,
  ShippingOption,
} from '../types.js';
import { toBrowseItemId } from './urls.js';

/**
 * Normalisation of eBay Browse API payloads into the connector's domain model.
 *
 * eBay returns money as `{ value: "12.34", currency: "USD" }` — a *string* amount — and omits
 * fields liberally. Every accessor here is defensive: an unexpected shape yields `undefined`
 * rather than throwing, because a single odd field must never make a whole listing unreadable.
 */

const MAX_ADDITIONAL_IMAGES = 12;
const MAX_ITEM_SPECIFICS = 60;
const MAX_SHIPPING_OPTIONS = 10;
const MAX_SHIP_TO_COUNTRIES = 40;

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const str = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
};

const bool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
};

const int = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
};

/** eBay reports percentages as strings such as `"98.7"`. */
const decimal = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

/** Parses an eBay `Amount` (`{ value, currency }`) into a numeric {@link Money}. */
export const toMoney = (value: unknown): Money | undefined => {
  const source = asObject(value);
  if (!source) return undefined;
  const amount = decimal(source['value']);
  const currency = str(source['currency']);
  if (amount === undefined || currency === undefined) return undefined;
  return { value: amount, currency };
};

/** Adds two amounts, refusing to mix currencies. Money is rounded to cents. */
export const addMoney = (a: Money | undefined, b: Money | undefined): Money | undefined => {
  if (!a) return undefined;
  if (!b) return a;
  if (a.currency !== b.currency) return undefined;
  return { value: Math.round((a.value + b.value) * 100) / 100, currency: a.currency };
};

/**
 * Item price plus shipping, but only when shipping is actually known. eBay quotes calculated
 * shipping without a cost when no buyer location is supplied, and reporting the bare item price
 * as a "delivered total" in that case would understate the real cost.
 */
export const deliveredTotal = (
  base: Money | undefined,
  shipping: Money | undefined,
): Money | undefined => (shipping === undefined ? undefined : addMoney(base, shipping));

const BUYING_OPTIONS: readonly BuyingOption[] = [
  'FIXED_PRICE',
  'AUCTION',
  'BEST_OFFER',
  'CLASSIFIED_AD',
];

const toBuyingOptions = (value: unknown): readonly BuyingOption[] => {
  const seen = new Set<BuyingOption>();
  for (const entry of asArray(value)) {
    const option = str(entry)?.toUpperCase();
    if (option && (BUYING_OPTIONS as readonly string[]).includes(option)) {
      seen.add(option as BuyingOption);
    }
  }
  return [...seen];
};

const toSeller = (value: unknown): SellerInfo => {
  const source = asObject(value) ?? {};
  return {
    username: str(source['username']),
    feedbackPercentage: decimal(source['feedbackPercentage']),
    feedbackScore: int(source['feedbackScore']),
    sellerAccountType: str(source['sellerAccountType']),
  };
};

const toLocation = (value: unknown): LocationInfo => {
  const source = asObject(value) ?? {};
  return {
    city: str(source['city']),
    stateOrProvince: str(source['stateOrProvince']),
    postalCode: str(source['postalCode']),
    country: str(source['country']),
  };
};

export const toShippingOption = (value: unknown): ShippingOption | undefined => {
  const source = asObject(value);
  if (!source) return undefined;
  const cost = toMoney(source['shippingCost']);
  const costType = str(source['shippingCostType']);
  return {
    type: str(source['type']),
    serviceCode: str(source['shippingServiceCode']),
    carrierCode: str(source['shippingCarrierCode']),
    costType,
    cost,
    additionalCostPerUnit: toMoney(source['additionalShippingCostPerUnit']),
    importCharges: toMoney(source['importCharges']),
    fulfilledThrough: str(source['fulfilledThrough']),
    minEstimatedDeliveryDate: str(source['minEstimatedDeliveryDate']),
    maxEstimatedDeliveryDate: str(source['maxEstimatedDeliveryDate']),
    freeShipping: cost !== undefined && cost.value === 0,
  };
};

const toShippingOptions = (value: unknown): readonly ShippingOption[] =>
  asArray(value)
    .map(toShippingOption)
    .filter((option): option is ShippingOption => option !== undefined)
    .slice(0, MAX_SHIPPING_OPTIONS);

/**
 * The cheapest *known* shipping cost. Options with an unknown cost (eBay's `CALCULATED` type
 * without a buyer location) are ignored rather than treated as free.
 */
export const lowestShippingCost = (options: readonly ShippingOption[]): Money | undefined => {
  let lowest: Money | undefined;
  for (const option of options) {
    if (!option.cost) continue;
    if (!lowest || option.cost.value < lowest.value) lowest = option.cost;
  }
  return lowest;
};

const toReturnTerms = (value: unknown): ReturnTerms | undefined => {
  const source = asObject(value);
  if (!source) return undefined;
  const period = asObject(source['returnPeriod']);
  return {
    returnsAccepted: bool(source['returnsAccepted']),
    returnPeriodDays:
      str(period?.['unit'])?.toUpperCase() === 'CALENDAR_DAY' ? int(period?.['value']) : undefined,
    refundMethod: str(source['refundMethod']),
    returnMethod: str(source['returnMethod']),
    returnShippingCostPayer: str(source['returnShippingCostPayer']),
    restockingFeePercentage: str(source['restockingFeePercentage']),
  };
};

const toAvailability = (value: unknown): Availability | undefined => {
  const first = asObject(asArray(value)[0]);
  if (!first) return undefined;
  return {
    status: str(first['estimatedAvailabilityStatus']),
    availableQuantity: int(first['estimatedAvailableQuantity']),
    soldQuantity: int(first['estimatedSoldQuantity']),
    threshold: int(first['availabilityThreshold']),
    thresholdType: str(first['availabilityThresholdType']),
    deliveryOptions: asArray(first['deliveryOptions'])
      .map(str)
      .filter((entry): entry is string => entry !== undefined),
  };
};

/** `localizedAspects` are eBay's "item specifics" — the structured seller-declared attributes. */
const toItemSpecifics = (value: unknown): readonly ItemAspect[] => {
  const aspects: ItemAspect[] = [];
  for (const entry of asArray(value)) {
    const source = asObject(entry);
    const name = str(source?.['name']);
    const aspectValue = str(source?.['value']);
    if (name && aspectValue) aspects.push({ name, value: aspectValue });
    if (aspects.length >= MAX_ITEM_SPECIFICS) break;
  }
  return aspects;
};

const toProductIdentifiers = (item: Json): ProductIdentifiers => {
  const product = asObject(item['product']);
  return {
    epid: str(item['epid']) ?? str(product?.['epid']),
    brand: str(item['brand']) ?? str(product?.['brand']),
    mpn: str(item['mpn']) ?? str(asArray(product?.['mpns'])[0]),
    gtin: str(item['gtin']) ?? str(asArray(product?.['gtins'])[0]),
  };
};

const toImageUrl = (value: unknown): string | undefined => str(asObject(value)?.['imageUrl']);

const toAdditionalImageUrls = (value: unknown): readonly string[] =>
  asArray(value)
    .map(toImageUrl)
    .filter((url): url is string => url !== undefined)
    .slice(0, MAX_ADDITIONAL_IMAGES);

const toShipToCountries = (value: unknown): readonly string[] => {
  const included = asArray(asObject(value)?.['regionIncluded']);
  return included
    .map((entry) => str(asObject(entry)?.['regionName']))
    .filter((name): name is string => name !== undefined)
    .slice(0, MAX_SHIP_TO_COUNTRIES);
};

/**
 * Seconds until the listing ends. Returns `undefined` when eBay reports no end date (most
 * fixed-price listings) and a negative number once the end date is in the past.
 */
export const secondsUntil = (isoDate: string | undefined, nowMs: number): number | undefined => {
  if (!isoDate) return undefined;
  const end = Date.parse(isoDate);
  return Number.isNaN(end) ? undefined : Math.round((end - nowMs) / 1000);
};

/**
 * Whether a listing is still purchasable. eBay's Browse API does not return ended listings for
 * most queries, but `itemEndDate` in the past and an out-of-stock availability status both mean
 * the listing must not be presented as a live buying opportunity.
 */
const isActive = (secondsRemaining: number | undefined, availabilityStatus: string | undefined) => {
  const ended = secondsRemaining !== undefined && secondsRemaining <= 0;
  const outOfStock = availabilityStatus?.toUpperCase() === 'OUT_OF_STOCK';
  return { ended, active: !ended && !outOfStock };
};

export interface NormaliseOptions {
  readonly marketplaceId: MarketplaceId;
  readonly nowMs?: number;
}

/** Normalises a Browse API `Item` (the `getItem` / `getItemByLegacyId` response). */
export const normaliseListing = (payload: unknown, options: NormaliseOptions): Listing => {
  const item = asObject(payload) ?? {};
  const nowMs = options.nowMs ?? Date.now();

  const legacyItemId = str(item['legacyItemId']);
  const itemId = str(item['itemId']) ?? (legacyItemId ? toBrowseItemId(legacyItemId) : '');

  const buyingOptions = toBuyingOptions(item['buyingOptions']);
  const shippingOptions = toShippingOptions(item['shippingOptions']);
  const cheapestShipping = lowestShippingCost(shippingOptions);
  const price = toMoney(item['price']);
  const currentBidPrice = toMoney(item['currentBidPrice']);

  const itemEndDate = str(item['itemEndDate']);
  const secondsRemaining = secondsUntil(itemEndDate, nowMs);
  const availability = toAvailability(item['estimatedAvailabilities']);
  const { ended, active } = isActive(secondsRemaining, availability?.status);

  const marketingPrice = asObject(item['marketingPrice']);

  return {
    itemId,
    legacyItemId,
    title: str(item['title']) ?? '(untitled listing)',
    subtitle: str(item['subtitle']),
    shortDescription: str(item['shortDescription']),
    itemWebUrl: str(item['itemWebUrl']),
    itemAffiliateWebUrl: str(item['itemAffiliateWebUrl']),
    marketplaceId: options.marketplaceId,
    listingMarketplaceId: str(item['listingMarketplaceId']),

    price,
    currentBidPrice,
    minimumPriceToBid: toMoney(item['minimumPriceToBid']),
    unitPrice: toMoney(item['unitPrice']),
    unitPricingMeasure: str(item['unitPricingMeasure']),
    originalPrice: toMoney(marketingPrice?.['originalPrice']),
    discountPercentage: str(marketingPrice?.['discountPercentage']),

    buyingOptions,
    isAuction: buyingOptions.includes('AUCTION'),
    isFixedPrice: buyingOptions.includes('FIXED_PRICE'),
    acceptsBestOffer: buyingOptions.includes('BEST_OFFER'),
    bidCount: int(item['bidCount']),
    uniqueBidderCount: int(item['uniqueBidderCount']),
    reservePriceMet: bool(item['reservePriceMet']),

    itemCreationDate: str(item['itemCreationDate']),
    itemEndDate,
    secondsRemaining,
    ended,
    availabilityStatus: availability?.status,
    active,

    condition: str(item['condition']),
    conditionId: str(item['conditionId']),
    conditionDescription: str(item['conditionDescription']),

    seller: toSeller(item['seller']),
    itemLocation: toLocation(item['itemLocation']),

    shippingOptions,
    lowestShippingCost: cheapestShipping,
    // For an auction in progress the meaningful figure is the current bid, not the start price.
    estimatedDeliveredTotal: deliveredTotal(currentBidPrice ?? price, cheapestShipping),
    shipsToCountries: toShipToCountries(item['shipToLocations']),

    returnTerms: toReturnTerms(item['returnTerms']),
    availability,

    categoryId: str(item['categoryId']),
    categoryPath: str(item['categoryPath']),
    categoryIdPath: str(item['categoryIdPath']),
    leafCategoryIds: asArray(item['leafCategoryIds'])
      .map(str)
      .filter((id): id is string => id !== undefined),

    itemSpecifics: toItemSpecifics(item['localizedAspects']),
    productIdentifiers: toProductIdentifiers(item),

    imageUrl: toImageUrl(item['image']),
    additionalImageUrls: toAdditionalImageUrls(item['additionalImages']),

    topRatedBuyingExperience: bool(item['topRatedBuyingExperience']),
    qualifiedPrograms: asArray(item['qualifiedPrograms'])
      .map(str)
      .filter((program): program is string => program !== undefined),
    adultOnly: bool(item['adultOnly']),
    lotSize: int(item['lotSize']),
    sellerItemRevision: str(item['sellerItemRevision']),
  };
};

/** Normalises one entry of the `item_summary/search` response. */
export const normaliseListingSummary = (
  payload: unknown,
  options: NormaliseOptions,
): ListingSummary => {
  const item = asObject(payload) ?? {};
  const nowMs = options.nowMs ?? Date.now();

  const legacyItemId = str(item['legacyItemId']);
  const itemId = str(item['itemId']) ?? (legacyItemId ? toBrowseItemId(legacyItemId) : '');
  const buyingOptions = toBuyingOptions(item['buyingOptions']);
  const shippingOptions = toShippingOptions(item['shippingOptions']);
  const cheapestShipping = lowestShippingCost(shippingOptions);
  const price = toMoney(item['price']);
  const currentBidPrice = toMoney(item['currentBidPrice']);

  const itemEndDate = str(item['itemEndDate']);
  const secondsRemaining = secondsUntil(itemEndDate, nowMs);
  const { ended, active } = isActive(secondsRemaining, undefined);

  const categoryIds = [
    ...asArray(item['leafCategoryIds']).map(str),
    ...asArray(item['categories']).map((entry) => str(asObject(entry)?.['categoryId'])),
  ].filter((id): id is string => id !== undefined);

  return {
    itemId,
    legacyItemId,
    title: str(item['title']) ?? '(untitled listing)',
    itemWebUrl: str(item['itemWebUrl']),
    itemAffiliateWebUrl: str(item['itemAffiliateWebUrl']),
    price,
    currentBidPrice,
    bidCount: int(item['bidCount']),
    buyingOptions,
    isAuction: buyingOptions.includes('AUCTION'),
    isFixedPrice: buyingOptions.includes('FIXED_PRICE'),
    acceptsBestOffer: buyingOptions.includes('BEST_OFFER'),
    condition: str(item['condition']),
    conditionId: str(item['conditionId']),
    seller: toSeller(item['seller']),
    itemLocation: toLocation(item['itemLocation']),
    lowestShippingCost: cheapestShipping,
    estimatedDeliveredTotal: deliveredTotal(currentBidPrice ?? price, cheapestShipping),
    itemCreationDate: str(item['itemCreationDate']),
    itemEndDate,
    secondsRemaining,
    ended,
    active,
    categoryIds: [...new Set(categoryIds)],
    epid: str(item['epid']),
    imageUrl:
      toImageUrl(item['image']) ?? str(asObject(asArray(item['thumbnailImages'])[0])?.['imageUrl']),
    marketplaceId: options.marketplaceId,
  };
};

/** Pulls the human-readable text out of the `warnings` array eBay may attach to a response. */
export const normaliseWarnings = (payload: unknown): readonly string[] =>
  asArray(asObject(payload)?.['warnings'])
    .map((entry) => {
      const warning = asObject(entry);
      return str(warning?.['longMessage']) ?? str(warning?.['message']);
    })
    .filter((message): message is string => message !== undefined)
    .slice(0, 10);

export const normaliseTotal = (payload: unknown): number | undefined =>
  int(asObject(payload)?.['total']);
