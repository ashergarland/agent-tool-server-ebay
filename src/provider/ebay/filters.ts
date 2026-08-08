import { badRequest } from '../../errors.js';
import type { SearchFilters, SearchSort } from '../types.js';

/**
 * Builds the eBay Browse `filter` expression.
 *
 * eBay's filter syntax is a comma-separated list of `name:value` pairs where set values use
 * `{A|B}` and ranges use `[low..high]`. Values that could contain a delimiter (seller usernames,
 * category ids) are validated rather than escaped, because eBay defines no escape mechanism.
 *
 * Reference: https://developer.ebay.com/api-docs/buy/static/ref-buy-browse-filters.html
 */

/** Sort values the Browse API documents. `bestMatch` is eBay's default and is sent as no sort. */
const SORT_VALUES: Record<SearchSort, string | undefined> = {
  bestMatch: undefined,
  newlyListed: 'newlyListed',
  priceAsc: 'price',
  priceDesc: '-price',
};

export const toEbaySort = (sort: SearchSort): string | undefined => SORT_VALUES[sort];

const SAFE_TOKEN = /^[A-Za-z0-9_.\-*]{1,64}$/;
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;
const POSTAL_CODE = /^[A-Za-z0-9 -]{1,20}$/;
const CATEGORY_ID = /^\d{1,15}$/;
const CONDITION_ID = /^\d{1,6}$/;

const assertTokens = (values: readonly string[], label: string, pattern: RegExp): string[] => {
  for (const value of values) {
    if (!pattern.test(value)) {
      throw badRequest(`${label} contains an unsupported value: '${value}'`);
    }
  }
  return [...values];
};

const set = (name: string, values: readonly string[]): string => `${name}:{${values.join('|')}}`;

/**
 * eBay range syntax: `[min..max]`, `[min]` for "at least" and `[..max]` for "at most".
 * Amounts are emitted with at most two decimal places so eBay never sees float noise.
 */
const priceRange = (min: number | undefined, max: number | undefined): string | undefined => {
  const format = (value: number): string => (Math.round(value * 100) / 100).toString();
  if (min !== undefined && max !== undefined) {
    if (min > max) throw badRequest('minPrice must not be greater than maxPrice');
    return `price:[${format(min)}..${format(max)}]`;
  }
  if (min !== undefined) return `price:[${format(min)}]`;
  if (max !== undefined) return `price:[..${format(max)}]`;
  return undefined;
};

export interface BuiltFilter {
  readonly filter: string | undefined;
  /** Query parameters that are *not* part of the `filter` expression. */
  readonly params: Readonly<Record<string, string | undefined>>;
}

export const buildSearchFilter = (input: SearchFilters): BuiltFilter => {
  const clauses: string[] = [];

  const price = priceRange(input.minPrice, input.maxPrice);
  if (price) {
    clauses.push(price);
    // eBay requires priceCurrency whenever a price filter is present.
    const currency = (input.currency ?? 'USD').toUpperCase();
    if (!CURRENCY_CODE.test(currency)) {
      throw badRequest(`currency must be a three letter ISO 4217 code, received '${currency}'`);
    }
    clauses.push(`priceCurrency:${currency}`);
  }

  if (input.conditions?.length) {
    clauses.push(set('conditions', assertTokens(input.conditions, 'conditions', SAFE_TOKEN)));
  }
  if (input.conditionIds?.length) {
    clauses.push(
      set('conditionIds', assertTokens(input.conditionIds, 'conditionIds', CONDITION_ID)),
    );
  }
  if (input.buyingOptions?.length) {
    clauses.push(
      set('buyingOptions', assertTokens(input.buyingOptions, 'buyingOptions', SAFE_TOKEN)),
    );
  }
  if (input.itemLocationCountry) {
    if (!COUNTRY_CODE.test(input.itemLocationCountry)) {
      throw badRequest('itemLocationCountry must be a two letter ISO 3166 country code');
    }
    clauses.push(`itemLocationCountry:${input.itemLocationCountry.toUpperCase()}`);
  }
  if (input.deliveryCountry) {
    if (!COUNTRY_CODE.test(input.deliveryCountry)) {
      throw badRequest('deliveryCountry must be a two letter ISO 3166 country code');
    }
    clauses.push(`deliveryCountry:${input.deliveryCountry.toUpperCase()}`);
  }
  if (input.deliveryPostalCode) {
    if (!input.deliveryCountry) {
      throw badRequest('deliveryPostalCode requires deliveryCountry to be supplied as well');
    }
    if (!POSTAL_CODE.test(input.deliveryPostalCode)) {
      throw badRequest('deliveryPostalCode contains unsupported characters');
    }
    clauses.push(`deliveryPostalCode:${input.deliveryPostalCode}`);
  }
  if (input.freeShippingOnly) {
    // eBay documents `0` as the only supported value for this filter.
    clauses.push('maxDeliveryCost:0');
  }
  if (input.returnsAcceptedOnly) {
    clauses.push('returnsAccepted:true');
  }
  if (input.sellers?.length) {
    clauses.push(set('sellers', assertTokens(input.sellers, 'sellers', SAFE_TOKEN)));
  }
  if (input.excludeSellers?.length) {
    clauses.push(
      set('excludeSellers', assertTokens(input.excludeSellers, 'excludeSellers', SAFE_TOKEN)),
    );
  }
  if (input.excludeCategoryIds?.length) {
    clauses.push(
      set(
        'excludeCategoryIds',
        assertTokens(input.excludeCategoryIds, 'excludeCategoryIds', CATEGORY_ID),
      ),
    );
  }
  if (input.searchInDescription) {
    if (!input.query) {
      throw badRequest('searchInDescription requires a keyword query');
    }
    clauses.push('searchInDescription:true');
  }

  const categoryIds = input.categoryIds?.length
    ? assertTokens(input.categoryIds, 'categoryIds', CATEGORY_ID).join(',')
    : undefined;

  return {
    filter: clauses.length > 0 ? clauses.join(',') : undefined,
    params: {
      category_ids: categoryIds,
      epid: input.epid,
      gtin: input.gtin,
      aspect_filter: input.aspectFilter,
    },
  };
};
