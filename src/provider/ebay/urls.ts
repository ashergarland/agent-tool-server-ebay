import { badRequest } from '../../errors.js';
import { marketplaceForHost, type MarketplaceId } from './marketplaces.js';

/**
 * eBay item references arrive from ChatGPT in whatever shape the user pasted. This module turns
 * all of them into the two canonical forms the Browse API understands:
 *
 * - a Browse item id, e.g. `v1|407111131587|0`
 * - a legacy (site) item id, e.g. `407111131587`, optionally with a variation id
 *
 * Parsing is done with the `URL` parser plus narrowly scoped regular expressions. String
 * splitting on `/` is deliberately avoided: eBay listing URLs carry SEO slugs, query strings and
 * tracking parameters that make positional parsing unreliable.
 */

/** Legacy eBay item ids are numeric and (currently) 9-12 digits; allow a little headroom. */
const LEGACY_ITEM_ID = /^\d{9,15}$/;

/** Browse item ids look like `v1|<legacyItemId>|<legacyVariationId>`. */
const BROWSE_ITEM_ID = /^v(\d+)\|(\d{1,20})\|(\d{1,20})$/i;

/** `/itm/<slug>/<id>` or `/itm/<id>`; the id is always the last numeric path segment. */
const ITM_PATH = /\/itm\/(?:[^/]*\/)*(\d{9,15})(?:\/)?$/i;

/** `/p/<epid>` product pages, which describe a catalogue product rather than a single listing. */
const PRODUCT_PATH = /\/p\/(?:[^/]*\/)*(\d{1,20})(?:\/)?$/i;

/** Legacy `eBayISAPI.dll?ViewItem&item=<id>` links still appear in old bookmarks and emails. */
const ISAPI_PATH = /eBayISAPI\.dll$/i;

const MAX_INPUT_LENGTH = 2048;

export type ItemReferenceKind = 'listing' | 'product';

export interface ItemReference {
  readonly kind: ItemReferenceKind;
  /** Browse API item id (`v1|...|...`) when the caller supplied one. */
  readonly itemId: string | undefined;
  /** Numeric site item id, present for every listing reference. */
  readonly legacyItemId: string | undefined;
  /** Numeric variation id for multi-variation listings; `0` is normalised away. */
  readonly legacyVariationId: string | undefined;
  /** eBay catalogue product id, only present for `/p/` product page references. */
  readonly epid: string | undefined;
  /** Marketplace implied by the hostname, when the input was a URL on a known eBay site. */
  readonly marketplaceId: MarketplaceId | undefined;
  /** The canonical listing URL, when one could be derived from the input. */
  readonly sourceUrl: string | undefined;
  /** The original caller-supplied string, trimmed. */
  readonly raw: string;
}

const reference = (partial: Partial<ItemReference> & { raw: string }): ItemReference => ({
  kind: partial.kind ?? 'listing',
  itemId: partial.itemId,
  legacyItemId: partial.legacyItemId,
  legacyVariationId: partial.legacyVariationId,
  epid: partial.epid,
  marketplaceId: partial.marketplaceId,
  sourceUrl: partial.sourceUrl,
  raw: partial.raw,
});

/** `0` is eBay's "no variation" sentinel and must not be sent as a real variation id. */
const normaliseVariationId = (value: string | null | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,20}$/.test(trimmed)) return undefined;
  return /^0+$/.test(trimmed) ? undefined : trimmed;
};

/** Builds a Browse item id from its legacy parts. */
export const toBrowseItemId = (legacyItemId: string, legacyVariationId?: string): string =>
  `v1|${legacyItemId}|${legacyVariationId ?? '0'}`;

/** Splits a Browse item id back into its legacy parts, or `undefined` if it is not one. */
export const parseBrowseItemId = (
  value: string,
): { legacyItemId: string; legacyVariationId: string | undefined } | undefined => {
  const match = BROWSE_ITEM_ID.exec(value.trim());
  if (!match?.[2]) return undefined;
  return {
    legacyItemId: match[2],
    legacyVariationId: normaliseVariationId(match[3]),
  };
};

/** True when the string is a bare numeric legacy item id. */
export const isLegacyItemId = (value: string): boolean => LEGACY_ITEM_ID.test(value.trim());

const parseUrl = (value: string): URL | undefined => {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Extracts an item id from the query string. eBay uses `item` on legacy ISAPI links and
 * occasionally surfaces `itemId`; `var` carries the selected variation on multi-variation
 * listings.
 */
const queryItemId = (url: URL): string | undefined => {
  for (const key of ['item', 'itemId', 'itemid']) {
    const value = url.searchParams.get(key)?.trim();
    if (value && LEGACY_ITEM_ID.test(value)) return value;
  }
  return undefined;
};

const queryVariationId = (url: URL): string | undefined => {
  for (const key of ['var', 'variationId']) {
    const normalised = normaliseVariationId(url.searchParams.get(key));
    if (normalised) return normalised;
  }
  return undefined;
};

const canonicalUrl = (url: URL, legacyItemId: string): string =>
  `${url.protocol}//${url.hostname}/itm/${legacyItemId}`;

/**
 * Parses any user-supplied eBay item reference. Throws a `bad_request` `AppError` with an
 * actionable message when the input cannot be resolved to a listing.
 */
export const parseItemReference = (input: unknown): ItemReference => {
  if (typeof input !== 'string') {
    throw badRequest('An eBay item reference must be a string (listing URL or item id).');
  }

  const raw = input.trim();
  if (raw.length === 0) {
    throw badRequest('An eBay item reference must not be empty.');
  }
  if (raw.length > MAX_INPUT_LENGTH) {
    throw badRequest(`An eBay item reference must be at most ${MAX_INPUT_LENGTH} characters.`);
  }

  const browse = parseBrowseItemId(raw);
  if (browse) {
    return reference({
      raw,
      itemId: toBrowseItemId(browse.legacyItemId, browse.legacyVariationId),
      legacyItemId: browse.legacyItemId,
      legacyVariationId: browse.legacyVariationId,
    });
  }

  if (LEGACY_ITEM_ID.test(raw)) {
    return reference({ raw, legacyItemId: raw, itemId: toBrowseItemId(raw) });
  }

  // A bare number that is not a plausible item id is a common paste mistake; say so precisely.
  if (/^\d+$/.test(raw)) {
    throw badRequest(
      `'${raw}' is not a valid eBay item id: legacy item ids are 9 to 15 digits. ` +
        'Paste the full listing URL instead.',
    );
  }

  const url = parseUrl(raw);
  if (!url) {
    throw badRequest(
      `Could not parse '${raw}' as an eBay listing. Provide a listing URL such as ` +
        'https://www.ebay.com/itm/407111131587, a numeric item id, or a Browse item id ' +
        'such as v1|407111131587|0.',
    );
  }

  const marketplaceId = marketplaceForHost(url.hostname);
  if (!marketplaceId) {
    throw badRequest(
      `'${url.hostname}' is not a supported eBay marketplace host. Supported hosts include ` +
        'ebay.com, ebay.co.uk, ebay.de, ebay.com.au, ebay.ca and other eBay country sites.',
    );
  }

  const variationFromQuery = queryVariationId(url);

  const itmMatch = ITM_PATH.exec(url.pathname);
  const legacyItemId = itmMatch?.[1] ?? queryItemId(url);

  if (legacyItemId) {
    return reference({
      raw,
      marketplaceId,
      legacyItemId,
      legacyVariationId: variationFromQuery,
      itemId: toBrowseItemId(legacyItemId, variationFromQuery),
      sourceUrl: canonicalUrl(url, legacyItemId),
    });
  }

  const productMatch = PRODUCT_PATH.exec(url.pathname);
  if (productMatch?.[1]) {
    return reference({
      raw,
      kind: 'product',
      marketplaceId,
      epid: productMatch[1],
      sourceUrl: `${url.protocol}//${url.hostname}/p/${productMatch[1]}`,
    });
  }

  if (ISAPI_PATH.test(url.pathname)) {
    throw badRequest(
      'That legacy eBay link does not carry an item id. Open the listing and copy the URL ' +
        'from the address bar, which looks like https://www.ebay.com/itm/407111131587.',
    );
  }

  throw badRequest(
    `'${raw}' is an eBay URL but does not point at a single listing. Listing URLs contain ` +
      '/itm/ followed by the numeric item id.',
  );
};

/**
 * Resolves the marketplace to call the Browse API with: an explicit caller choice always wins,
 * then the marketplace implied by the pasted URL, then the connector default.
 */
export const resolveMarketplace = (
  requested: MarketplaceId | undefined,
  reference_: ItemReference | undefined,
  fallback: MarketplaceId,
): MarketplaceId => requested ?? reference_?.marketplaceId ?? fallback;
