import type {
  FulfillmentDiagnostics,
  FulfillmentOption,
  FulfillmentSummary,
  Money,
  ShippingOption,
} from '../types.js';

/**
 * Fulfillment normalisation.
 *
 * eBay describes how a buyer can receive an item in several different places, and a listing can
 * offer more than one method at the same time: shipped delivery *and* free local pickup is a
 * common combination. Earlier versions of this connector read `shippingOptions` as a flat list of
 * interchangeable quotes, which produced two bugs:
 *
 *  - the cheapest "shipping" cost could be the $0 local-pickup row, hiding the real shipped price
 *    and understating `estimatedDeliveredTotal`;
 *  - a listing that offered pickup was easy for a downstream consumer to read as pickup-only.
 *
 * This module classifies every fulfillment source eBay may return into explicit
 * {@link FulfillmentOption}s and derives the convenience fields callers actually reason with.
 * Nothing is dropped: pickup and shipping coexist, and "no cost quoted" is kept distinct from
 * "cannot be shipped".
 */

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

const decimal = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

const toMoney = (value: unknown): Money | undefined => {
  const source = asObject(value);
  if (!source) return undefined;
  const amount = decimal(source['value']);
  const currency = str(source['currency']);
  if (amount === undefined || currency === undefined) return undefined;
  return { value: amount, currency };
};

const MAX_FULFILLMENT_OPTIONS = 20;

/**
 * Containers that have carried shipping quotes across Browse endpoints and marketplaces. The
 * canonical one is `shippingOptions`; the rest are tolerated so an unexpected nesting does not
 * make a shippable listing look unshippable.
 */
const SHIPPING_OPTION_PATHS: readonly (readonly string[])[] = [
  ['shippingOptions'],
  ['shippingOption'],
  ['deliveryOptions'],
  ['shipping', 'shippingOptions'],
  ['shipping', 'options'],
  ['fulfillment', 'shippingOptions'],
  ['fulfillment', 'options'],
  ['deliveryInfo', 'shippingOptions'],
  ['itemShipping', 'shippingOptions'],
];

/** eBay spells pickup a dozen ways across fields; all of them contain "pick up" or "collect". */
const PICKUP_PATTERN = /pick\s*-?\s*up|pickup|collect(?:ion)?|click\s*(?:and|&)\s*collect/i;
const SHIP_TO_HOME_PATTERN = /ship_to_home|ship to home|shipping|delivery/i;

const isPickupText = (value: string | undefined): boolean =>
  value !== undefined && PICKUP_PATTERN.test(value);

/** Reads a nested value by path without throwing on any missing or oddly typed segment. */
const readPath = (root: Json, path: readonly string[]): unknown => {
  let current: unknown = root;
  for (const segment of path) {
    const object = asObject(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
};

const isMoneyLike = (value: unknown): boolean => toMoney(value) !== undefined;

/**
 * True when a raw entry looks like an eBay shipping quote rather than, say, the plain
 * `deliveryOptions: ["SHIP_TO_HOME"]` string enum that shares the field name.
 */
const looksLikeShippingQuote = (value: unknown): boolean => {
  const source = asObject(value);
  if (!source) return false;
  return (
    'shippingCost' in source ||
    'shippingCostType' in source ||
    'shippingServiceCode' in source ||
    'shippingCarrierCode' in source ||
    'minEstimatedDeliveryDate' in source ||
    'maxEstimatedDeliveryDate' in source ||
    'type' in source ||
    'cost' in source ||
    'fulfilledThrough' in source
  );
};

interface RawQuote {
  readonly raw: Json;
  readonly source: string;
}

/** A quote is pickup when any of the fields eBay uses to name the service says so. */
const isPickupQuote = (raw: Json): boolean =>
  [
    str(raw['type']),
    str(raw['shippingServiceCode']),
    str(raw['shippingCarrierCode']),
    str(raw['shippingCostType']),
    str(raw['fulfilledThrough']),
    str(raw['shippingServiceName']),
  ].some(isPickupText);

/** Collects every shipping-quote-shaped object found anywhere in the known containers. */
const collectQuotes = (item: Json): readonly RawQuote[] => {
  const quotes: RawQuote[] = [];
  const seen = new Set<unknown>();

  for (const path of SHIPPING_OPTION_PATHS) {
    const value = readPath(item, path);
    if (value === undefined) continue;
    const source = path.join('.');
    const entries = Array.isArray(value) ? value : [value];
    for (const entry of entries) {
      if (!looksLikeShippingQuote(entry) || seen.has(entry)) continue;
      seen.add(entry);
      const object = asObject(entry);
      if (object) quotes.push({ raw: object, source });
    }
  }

  // Some marketplaces flatten a single quote onto the item itself (`shippingCost` +
  // `shippingCostType` without any container). That is still a usable shipping price, and it must
  // survive a container that lists nothing but pickup rows — otherwise a listing offering paid
  // shipping alongside free local pickup would collapse into pickup-only.
  const hasShippedQuote = quotes.some((quote) => !isPickupQuote(quote.raw));
  if (
    !hasShippedQuote &&
    (isMoneyLike(item['shippingCost']) || str(item['shippingCostType']) !== undefined) &&
    !isPickupQuote(item)
  ) {
    quotes.push({ raw: item, source: 'item.shippingCost' });
  }

  return quotes.slice(0, MAX_FULFILLMENT_OPTIONS);
};

const toShippingOptionShape = (raw: Json): ShippingOption => {
  const cost = toMoney(raw['shippingCost']) ?? toMoney(raw['cost']);
  return {
    type: str(raw['type']) ?? str(raw['shippingServiceName']),
    serviceCode: str(raw['shippingServiceCode']),
    carrierCode: str(raw['shippingCarrierCode']),
    costType: str(raw['shippingCostType']),
    cost,
    additionalCostPerUnit: toMoney(raw['additionalShippingCostPerUnit']),
    importCharges: toMoney(raw['importCharges']),
    fulfilledThrough: str(raw['fulfilledThrough']),
    minEstimatedDeliveryDate: str(raw['minEstimatedDeliveryDate']),
    maxEstimatedDeliveryDate: str(raw['maxEstimatedDeliveryDate']),
    freeShipping: cost !== undefined && cost.value === 0,
  };
};

/** eBay's `estimatedAvailabilities[].deliveryOptions` enum values, e.g. SHIP_TO_HOME. */
const deliveryOptionEnums = (item: Json): readonly string[] => {
  const values: string[] = [];
  for (const availability of asArray(item['estimatedAvailabilities'])) {
    for (const option of asArray(asObject(availability)?.['deliveryOptions'])) {
      const value = str(option);
      if (value) values.push(value);
    }
  }
  for (const option of asArray(item['deliveryOptions'])) {
    const value = str(option);
    if (value) values.push(value);
  }
  return [...new Set(values)];
};

/** `pickupOptions` appears on search summaries for in-store / seller-arranged pickup. */
const hasPickupOptions = (item: Json): boolean =>
  asArray(item['pickupOptions']).some((entry) => {
    const option = asObject(entry);
    if (!option) return isPickupText(str(entry));
    return true;
  });

interface ShipToDecision {
  /** False only when eBay's shipToLocations positively exclude the requested country. */
  readonly excluded: boolean;
  readonly evaluated: boolean;
}

const regionCodes = (value: unknown): readonly string[] =>
  asArray(value)
    .map((entry) => {
      const region = asObject(entry);
      return str(region?.['regionId']) ?? str(region?.['regionName']);
    })
    .filter((entry): entry is string => entry !== undefined)
    .map((entry) => entry.toUpperCase());

const regionTypes = (value: unknown): readonly string[] =>
  asArray(value)
    .map((entry) => str(asObject(entry)?.['regionType'])?.toUpperCase())
    .filter((entry): entry is string => entry !== undefined);

/**
 * Whether eBay's `shipToLocations` rule out the buyer's country. Only a positive exclusion counts:
 * region names are free text and continents cannot be resolved to countries here, so anything
 * ambiguous leaves shipping availability to the quotes themselves.
 */
const evaluateShipToLocations = (item: Json, country: string | undefined): ShipToDecision => {
  const shipTo = asObject(item['shipToLocations']);
  if (!shipTo || !country) return { excluded: false, evaluated: false };
  const wanted = country.toUpperCase();

  const excludedRegions = regionCodes(shipTo['regionExcluded']);
  if (excludedRegions.includes(wanted)) return { excluded: true, evaluated: true };

  const included = regionCodes(shipTo['regionIncluded']);
  if (included.length === 0) return { excluded: false, evaluated: false };
  if (included.includes('WORLDWIDE') || included.includes(wanted)) {
    return { excluded: false, evaluated: true };
  }

  // Continent/region entries (e.g. "Europe") cannot be mapped to countries offline, so only an
  // all-country include list is treated as authoritative.
  const types = regionTypes(shipTo['regionIncluded']);
  const allCountries = types.length === included.length && types.every((t) => t === 'COUNTRY');
  return { excluded: allCountries, evaluated: allCountries };
};

export interface FulfillmentInput {
  /** The buyer's destination country, when one was supplied to eBay. */
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  /** The listing's price currency, used to express a free local pickup as a zero amount. */
  readonly currency?: string | undefined;
}

export interface FulfillmentResult extends FulfillmentSummary {
  /** The raw shipping quotes, pickup rows included, preserved for backwards compatibility. */
  readonly shippingOptions: readonly ShippingOption[];
  readonly diagnostics: FulfillmentDiagnostics;
}

const cheapest = (options: readonly FulfillmentOption[]): Money | undefined => {
  let lowest: Money | undefined;
  for (const option of options) {
    const cost = option.shippingCost;
    if (!cost) continue;
    if (!lowest || cost.value < lowest.value) lowest = cost;
  }
  return lowest;
};

/** The earliest/latest estimate across the shipped options that carry one. */
const deliveryWindow = (
  options: readonly FulfillmentOption[],
): { min: string | undefined; max: string | undefined } => {
  let min: string | undefined;
  let max: string | undefined;
  for (const option of options) {
    const optionMin = option.minEstimatedDeliveryDate;
    const optionMax = option.maxEstimatedDeliveryDate;
    if (optionMin && (min === undefined || optionMin < min)) min = optionMin;
    if (optionMax && (max === undefined || optionMax > max)) max = optionMax;
  }
  return { min, max };
};

/**
 * Normalises every fulfillment method eBay exposes for an item (or search summary) payload.
 *
 * Shipping and pickup are independent: the presence of one never removes the other, and the
 * shipped cost is always taken from a shipped option, never from a $0 pickup row.
 */
export const normaliseFulfillment = (
  payload: unknown,
  input: FulfillmentInput = {},
): FulfillmentResult => {
  const item = asObject(payload) ?? {};
  const quotes = collectQuotes(item);
  const enums = deliveryOptionEnums(item);
  const pickupOptionsPresent = hasPickupOptions(item);
  const destinationCountrySupplied = input.deliveryCountry !== undefined;
  const destinationPostalCodeSupplied = input.deliveryPostalCode !== undefined;
  /**
   * Supplying more of the buyer's address can only help while some of it is still missing. Once
   * eBay has both the country and the postal code and still returns no price, the cost is withheld
   * by the API, not waiting on the caller.
   */
  const moreLocationCouldHelp = !(destinationCountrySupplied && destinationPostalCodeSupplied);
  const currency = input.currency;
  const freeCost = (): Money | undefined =>
    currency === undefined ? undefined : { value: 0, currency };

  const shipping: FulfillmentOption[] = [];
  const pickup: FulfillmentOption[] = [];
  const shippingOptions: ShippingOption[] = [];

  for (const quote of quotes) {
    const shape = toShippingOptionShape(quote.raw);
    shippingOptions.push(shape);
    const isPickup = isPickupQuote(quote.raw);
    const costKnown = shape.cost !== undefined;

    const option: FulfillmentOption = {
      type: isPickup ? 'LOCAL_PICKUP' : 'SHIPPING',
      available: true,
      // A pickup row without a quoted cost is free by definition: the buyer collects it.
      ...(shape.cost !== undefined
        ? { shippingCost: shape.cost }
        : isPickup
          ? (() => {
              const cost = freeCost();
              return cost === undefined ? {} : { shippingCost: cost };
            })()
          : {}),
      shippingCostKnown: isPickup ? true : costKnown,
      shippingCostRequiresLocation: !isPickup && !costKnown && moreLocationCouldHelp,
      serviceName: shape.type,
      serviceCode: shape.serviceCode,
      carrierCode: shape.carrierCode,
      costType: shape.costType,
      fulfilledThrough: shape.fulfilledThrough,
      importCharges: shape.importCharges,
      additionalCostPerUnit: shape.additionalCostPerUnit,
      minEstimatedDeliveryDate: shape.minEstimatedDeliveryDate,
      maxEstimatedDeliveryDate: shape.maxEstimatedDeliveryDate,
      source: quote.source,
    };

    if (isPickup) pickup.push(option);
    else shipping.push(option);
  }

  // Pickup can also be declared without any quote row at all.
  const pickupFromEnums = enums.some(isPickupText);
  if (pickup.length === 0 && (pickupFromEnums || pickupOptionsPresent)) {
    pickup.push({
      type: 'LOCAL_PICKUP',
      available: true,
      ...(freeCost() === undefined ? {} : { shippingCost: freeCost() }),
      shippingCostKnown: true,
      shippingCostRequiresLocation: false,
      source: pickupOptionsPresent ? 'pickupOptions' : 'estimatedAvailabilities.deliveryOptions',
    });
  }

  const shipToHomeDeclared = enums.some(
    (value) => !isPickupText(value) && SHIP_TO_HOME_PATTERN.test(value),
  );

  // Shipping declared by `deliveryOptions` but not quoted: shippable, price simply not returned.
  if (shipping.length === 0 && shipToHomeDeclared) {
    shipping.push({
      type: 'SHIPPING',
      available: true,
      shippingCostKnown: false,
      shippingCostRequiresLocation: moreLocationCouldHelp,
      source: 'estimatedAvailabilities.deliveryOptions',
    });
  }

  const shipTo = evaluateShipToLocations(item, input.deliveryCountry);
  const shippingOptionsForDestination = shipTo.excluded
    ? shipping.map((option) => ({
        ...option,
        available: false,
        unavailableReason: 'DESTINATION_NOT_SERVED' as const,
      }))
    : shipping;

  const availableShipping = shippingOptionsForDestination.filter((option) => option.available);
  const shippingCost = cheapest(availableShipping);
  const window = deliveryWindow(availableShipping);

  const shippingAvailable = availableShipping.length > 0;
  const localPickupAvailable = pickup.length > 0;
  const shippingCostRequiresLocation =
    shippingAvailable &&
    shippingCost === undefined &&
    availableShipping.some((option) => option.shippingCostRequiresLocation);

  const diagnostics: FulfillmentDiagnostics = {
    sourceFields: [...new Set(quotes.map((quote) => quote.source))],
    deliveryOptionEnums: enums,
    pickupOptionsPresent,
    destinationCountrySupplied,
    destinationPostalCodeSupplied,
    shipToLocationsEvaluated: shipTo.evaluated,
    destinationExcludedByShipToLocations: shipTo.excluded,
    shippingOptionCount: shipping.length,
    localPickupOptionCount: pickup.length,
    classification: !shippingAvailable
      ? shipTo.excluded && shipping.length > 0
        ? 'SHIPPING_UNAVAILABLE_TO_DESTINATION'
        : localPickupAvailable
          ? 'LOCAL_PICKUP_ONLY'
          : 'NO_FULFILLMENT_DATA'
      : shippingCost !== undefined
        ? 'SHIPPING_COST_KNOWN'
        : shippingCostRequiresLocation
          ? 'SHIPPING_COST_REQUIRES_LOCATION'
          : 'SHIPPING_COST_UNKNOWN',
  };

  return {
    fulfillmentOptions: [...shippingOptionsForDestination, ...pickup],
    shippingOptions,
    shippingAvailable,
    localPickupAvailable,
    localPickupOnly: localPickupAvailable && !shippingAvailable,
    shippingCost,
    shippingCostKnown: shippingCost !== undefined,
    shippingCostRequiresLocation,
    minEstimatedDeliveryDate: window.min,
    maxEstimatedDeliveryDate: window.max,
    diagnostics,
  };
};
