import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normaliseFulfillment } from '../../src/provider/ebay/fulfillment.js';
import { normaliseListing, normaliseListingSummary } from '../../src/provider/ebay/normalize.js';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const options = { marketplaceId: 'EBAY_US', nowMs: NOW } as const;

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../fixtures/fulfillment/${name}.json`, import.meta.url)), {
      encoding: 'utf8',
    }),
  );

const usd = (value: number) => ({ value, currency: 'USD' });

describe('fulfillment normalisation', () => {
  it('A: reports fixed paid shipping with its delivery window', () => {
    const listing = normaliseListing(fixture('a-shipping-only-fixed'), options);

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.localPickupAvailable).toBe(false);
    expect(listing.localPickupOnly).toBe(false);
    expect(listing.shippingCost).toEqual(usd(6.5));
    expect(listing.shippingCostKnown).toBe(true);
    expect(listing.shippingCostRequiresLocation).toBe(false);
    expect(listing.minEstimatedDeliveryDate).toBe('2026-09-08T07:00:00.000Z');
    expect(listing.maxEstimatedDeliveryDate).toBe('2026-09-11T07:00:00.000Z');
    expect(listing.estimatedDeliveredTotal).toEqual(usd(31.49));
    expect(listing.fulfillmentOptions).toHaveLength(1);
    expect(listing.fulfillmentOptions[0]?.type).toBe('SHIPPING');
  });

  it('B: reports free shipping as a known zero cost, not as unknown', () => {
    const listing = normaliseListing(fixture('b-shipping-only-free'), options);

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.shippingCost).toEqual(usd(0));
    expect(listing.shippingCostKnown).toBe(true);
    expect(listing.estimatedDeliveredTotal).toEqual(usd(18));
  });

  it('C: reports local pickup only when there is no shippable option', () => {
    const listing = normaliseListing(fixture('c-local-pickup-only'), options);

    expect(listing.shippingAvailable).toBe(false);
    expect(listing.localPickupAvailable).toBe(true);
    expect(listing.localPickupOnly).toBe(true);
    expect(listing.shippingCost).toBeUndefined();
    expect(listing.shippingCostRequiresLocation).toBe(false);
    // A pickup-only listing has no shipped cost, so there is no delivered total to quote.
    expect(listing.estimatedDeliveredTotal).toBeUndefined();
    expect(listing.fulfillmentDiagnostics.classification).toBe('LOCAL_PICKUP_ONLY');
  });

  it('D: keeps shipping and free local pickup side by side', () => {
    const listing = normaliseListing(fixture('d-shipping-and-free-pickup'), options);

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.localPickupAvailable).toBe(true);
    expect(listing.localPickupOnly).toBe(false);
    expect(listing.fulfillmentOptions.map((option) => option.type)).toEqual([
      'SHIPPING',
      'LOCAL_PICKUP',
    ]);
    // The $0 pickup row must not be mistaken for the shipped price.
    expect(listing.shippingCost).toEqual(usd(5.48));
    expect(listing.estimatedDeliveredTotal).toEqual(usd(7.7));
  });

  it('E: returns the calculated cost eBay quotes for a known postal code', () => {
    const listing = normaliseListing(fixture('e-calculated-with-postal-code'), {
      ...options,
      deliveryCountry: 'US',
      deliveryPostalCode: '19406',
    });

    expect(listing.shippingCost).toEqual(usd(18.35));
    expect(listing.shippingCostKnown).toBe(true);
    expect(listing.shippingCostRequiresLocation).toBe(false);
    expect(listing.estimatedDeliveredTotal).toEqual(usd(168.35));
    expect(listing.fulfillmentDiagnostics.destinationPostalCodeSupplied).toBe(true);
  });

  it('F: distinguishes "needs a buyer location" from "cannot be shipped"', () => {
    const listing = normaliseListing(fixture('f-calculated-without-postal-code'), options);

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.localPickupOnly).toBe(false);
    expect(listing.shippingCost).toBeUndefined();
    expect(listing.shippingCostKnown).toBe(false);
    expect(listing.shippingCostRequiresLocation).toBe(true);
    expect(listing.estimatedDeliveredTotal).toBeUndefined();
    expect(listing.fulfillmentDiagnostics.classification).toBe('SHIPPING_COST_REQUIRES_LOCATION');
  });

  it('G: keeps every shipping service and prices the cheapest one', () => {
    const listing = normaliseListing(fixture('g-multiple-shipping-services'), options);

    expect(listing.fulfillmentOptions).toHaveLength(3);
    expect(listing.shippingCost).toEqual(usd(7.25));
    expect(listing.estimatedDeliveredTotal).toEqual(usd(67.25));
    // The window spans the fastest and slowest service eBay offered.
    expect(listing.minEstimatedDeliveryDate).toBe('2026-09-06T07:00:00.000Z');
    expect(listing.maxEstimatedDeliveryDate).toBe('2026-09-15T07:00:00.000Z');
  });

  it('H: finds shipping nested under a non-canonical container', () => {
    const listing = normaliseListing(fixture('h-nested-shipping'), options);

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.shippingCost).toEqual(usd(3.95));
    expect(listing.fulfillmentDiagnostics.sourceFields).toEqual(['fulfillment.shippingOptions']);
  });

  // Search never enriches its rows from item detail on its own; a caller that wants the priced
  // quote makes an explicit ebay_get_listing follow-up. This asserts the two views agree.
  it('I: search rows and item detail agree, and detail carries the better data', () => {
    const summary = normaliseListingSummary(fixture('i-search-summary-incomplete'), options);
    const detail = normaliseListing(fixture('i-item-detail-complete'), options);

    // The search row cannot price the shipping, but it must not deny that shipping exists.
    expect(summary.shippingAvailable).toBe(true);
    expect(summary.localPickupAvailable).toBe(true);
    expect(summary.localPickupOnly).toBe(false);
    expect(summary.shippingCostKnown).toBe(false);
    expect(summary.shippingCostRequiresLocation).toBe(true);
    expect(summary.estimatedDeliveredTotal).toBeUndefined();

    // An explicit detail follow-up adds the price without contradicting the search row.
    expect(detail.shippingAvailable).toBe(true);
    expect(detail.localPickupAvailable).toBe(true);
    expect(detail.shippingCost).toEqual(usd(14.2));
    expect(detail.estimatedDeliveredTotal).toEqual(usd(89.2));
  });

  it('J: reports shipping unavailable when the destination is excluded', () => {
    const listing = normaliseListing(fixture('j-shipping-unavailable-to-country'), {
      ...options,
      deliveryCountry: 'DE',
    });

    expect(listing.shippingAvailable).toBe(false);
    expect(listing.localPickupAvailable).toBe(false);
    expect(listing.localPickupOnly).toBe(false);
    expect(listing.shippingCost).toBeUndefined();
    expect(listing.shippingCostRequiresLocation).toBe(false);
    expect(listing.fulfillmentOptions[0]?.unavailableReason).toBe('DESTINATION_NOT_SERVED');
    // Destination exclusion is its own classification: eBay does ship this item, just not here.
    expect(listing.fulfillmentDiagnostics.classification).toBe(
      'SHIPPING_UNAVAILABLE_TO_DESTINATION',
    );
  });

  it('J: still ships to a country the listing does serve', () => {
    const listing = normaliseListing(fixture('j-shipping-unavailable-to-country'), {
      ...options,
      deliveryCountry: 'US',
    });

    expect(listing.shippingAvailable).toBe(true);
    expect(listing.shippingCost).toEqual(usd(9));
  });
});

describe('fulfillment regression: shipped delivery alongside free local pickup', () => {
  // Reproduction of the eBay share link that was reported as local-pickup-only: the buyer UI
  // shows $2.22 + $5.48 shipping with a 2–4 day estimate, plus free local pickup.
  it('exposes both the shipped option and the free pickup option', () => {
    const listing = normaliseListing(fixture('d-shipping-and-free-pickup'), {
      ...options,
      deliveryCountry: 'US',
      deliveryPostalCode: '19406',
    });

    expect(listing.localPickupOnly).toBe(false);
    expect(listing.shippingAvailable).toBe(true);
    expect(listing.localPickupAvailable).toBe(true);

    const shipping = listing.fulfillmentOptions.find((option) => option.type === 'SHIPPING');
    const pickup = listing.fulfillmentOptions.find((option) => option.type === 'LOCAL_PICKUP');

    expect(shipping?.available).toBe(true);
    expect(shipping?.shippingCost).toEqual(usd(5.48));
    expect(shipping?.minEstimatedDeliveryDate).toBe('2026-09-07T07:00:00.000Z');
    expect(shipping?.maxEstimatedDeliveryDate).toBe('2026-09-09T07:00:00.000Z');
    expect(pickup?.available).toBe(true);
    expect(pickup?.shippingCost).toEqual(usd(0));

    // Delivered total must use the shipped cost, never the $0 pickup cost.
    expect(listing.estimatedDeliveredTotal).toEqual(usd(7.7));
    expect(listing.lowestShippingCost).toEqual(usd(5.48));
  });
});

describe('fulfillment source discovery', () => {
  it('reads a flat shippingCost pair when there is no options container', () => {
    const result = normaliseFulfillment({
      shippingCost: { value: '4.00', currency: 'USD' },
      shippingCostType: 'FIXED',
    });

    expect(result.shippingAvailable).toBe(true);
    expect(result.shippingCost).toEqual(usd(4));
    expect(result.diagnostics.sourceFields).toEqual(['item.shippingCost']);
  });

  it('treats a SHIP_TO_HOME delivery option as shippable even with no quote', () => {
    const result = normaliseFulfillment({
      estimatedAvailabilities: [{ deliveryOptions: ['SHIP_TO_HOME'] }],
    });

    expect(result.shippingAvailable).toBe(true);
    expect(result.shippingCostKnown).toBe(false);
    expect(result.shippingCostRequiresLocation).toBe(true);
    expect(result.localPickupOnly).toBe(false);
  });

  it('detects pickup from pickupOptions alone', () => {
    const result = normaliseFulfillment(
      { pickupOptions: [{ pickupLocationType: 'STORE' }] },
      { currency: 'USD' },
    );

    expect(result.localPickupAvailable).toBe(true);
    expect(result.localPickupOnly).toBe(true);
    expect(result.fulfillmentOptions[0]?.shippingCost).toEqual(usd(0));
  });

  it('reports no fulfillment data rather than pickup when eBay returns nothing', () => {
    const result = normaliseFulfillment({});

    expect(result.shippingAvailable).toBe(false);
    expect(result.localPickupAvailable).toBe(false);
    expect(result.localPickupOnly).toBe(false);
    expect(result.diagnostics.classification).toBe('NO_FULFILLMENT_DATA');
  });

  it('records diagnostics without echoing credentials or tokens', () => {
    const result = normaliseFulfillment(fixture('d-shipping-and-free-pickup'), {
      deliveryCountry: 'US',
      currency: 'USD',
    });

    expect(result.diagnostics).toMatchObject({
      sourceFields: ['shippingOptions'],
      deliveryOptionEnums: ['SHIP_TO_HOME', 'SELLER_ARRANGED_LOCAL_PICKUP'],
      destinationCountrySupplied: true,
      destinationPostalCodeSupplied: false,
      shippingOptionCount: 1,
      localPickupOptionCount: 1,
      classification: 'SHIPPING_COST_KNOWN',
    });
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/token|authorization/i);
  });
});

describe('fulfillment review corrections', () => {
  it('keeps a paid top-level shippingCost when shippingOptions holds only pickup', () => {
    const result = normaliseFulfillment(
      {
        shippingOptions: [
          { type: 'Local Pickup', shippingCost: { value: '0.00', currency: 'USD' } },
        ],
        shippingCost: { value: '5.48', currency: 'USD' },
        shippingCostType: 'FIXED',
      },
      { currency: 'USD' },
    );

    expect(result.shippingAvailable).toBe(true);
    expect(result.localPickupAvailable).toBe(true);
    expect(result.localPickupOnly).toBe(false);
    expect(result.shippingCost).toEqual(usd(5.48));
    expect(result.diagnostics.sourceFields).toContain('item.shippingCost');
  });

  it('does not blame the buyer location when the full destination was already supplied', () => {
    const payload = { estimatedAvailabilities: [{ deliveryOptions: ['SHIP_TO_HOME'] }] };

    const complete = normaliseFulfillment(payload, {
      deliveryCountry: 'US',
      deliveryPostalCode: '19406',
    });

    expect(complete.shippingAvailable).toBe(true);
    expect(complete.shippingCostKnown).toBe(false);
    expect(complete.shippingCostRequiresLocation).toBe(false);
    expect(complete.diagnostics.classification).toBe('SHIPPING_COST_UNKNOWN');

    const countryOnly = normaliseFulfillment(payload, { deliveryCountry: 'US' });

    expect(countryOnly.shippingCostRequiresLocation).toBe(true);
    expect(countryOnly.diagnostics.classification).toBe('SHIPPING_COST_REQUIRES_LOCATION');
  });
});
