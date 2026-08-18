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
  /** Browse API item id (`v1|...|...`), either supplied by the caller or derived from a legacy id. */
  readonly itemId: string | undefined;
  /**
   * True only when the caller supplied a Browse API item id directly. Such an id must be sent to
   * `GET /item/{item_id}` unchanged: eBay documents Browse item ids and legacy ids as separate
   * identifier spaces, so downgrading one to the other is not a lossless round trip.
   */
  readonly browseItemIdSupplied: boolean;
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
  browseItemIdSupplied: partial.browseItemIdSupplied ?? false,
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
      browseItemIdSupplied: true,
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
  reference_: { readonly marketplaceId: MarketplaceId | undefined } | undefined,
  fallback: MarketplaceId,
): MarketplaceId => requested ?? reference_?.marketplaceId ?? fallback;

/* ------------------------------------------------------------- item groups */

/** eBay item group ids share the legacy item id format: the group's parent listing number. */
const ITEM_GROUP_ID = LEGACY_ITEM_ID;

/** `item_group_id` as it appears in eBay's `itemGroupHref` and in the 11006 error message. */
const ITEM_GROUP_ID_PARAM = /item_group_id=(\d{1,20})/i;

export interface ItemGroupReference {
  readonly itemGroupId: string;
  /** Marketplace implied by the hostname, when the input was a URL on a known eBay site. */
  readonly marketplaceId: MarketplaceId | undefined;
  /** The canonical parent listing URL, when one could be derived from the input. */
  readonly sourceUrl: string | undefined;
  /** The original caller-supplied string, trimmed. */
  readonly raw: string;
}

/**
 * Pulls the group id out of an eBay `itemGroupHref`
 * (`https://api.ebay.com/buy/browse/v1/item/get_items_by_item_group?item_group_id=142373490668`).
 */
export const itemGroupIdFromHref = (href: unknown): string | undefined => {
  if (typeof href !== 'string') return undefined;
  const match = ITEM_GROUP_ID_PARAM.exec(href);
  return match?.[1];
};

/**
 * Parses a caller-supplied reference to a multi-variation item group. Accepted forms are the
 * numeric group id, the parent listing URL (`/itm/<group-id>`), a Browse item id for one of the
 * variations (`v1|<group-id>|<variation-id>`, whose first segment *is* the group id) and eBay's
 * own `get_items_by_item_group?item_group_id=<id>` href.
 */
export const parseItemGroupReference = (input: unknown): ItemGroupReference => {
  if (typeof input !== 'string') {
    throw badRequest('An eBay item group reference must be a string (listing URL or group id).');
  }

  const raw = input.trim();
  if (raw.length === 0) {
    throw badRequest('An eBay item group reference must not be empty.');
  }
  if (raw.length > MAX_INPUT_LENGTH) {
    throw badRequest(
      `An eBay item group reference must be at most ${MAX_INPUT_LENGTH} characters.`,
    );
  }

  if (ITEM_GROUP_ID.test(raw)) {
    return { itemGroupId: raw, marketplaceId: undefined, sourceUrl: undefined, raw };
  }

  const browse = parseBrowseItemId(raw);
  if (browse) {
    // A variation's Browse item id is `v1|<group id>|<variation id>`, so the group id is exact.
    return {
      itemGroupId: browse.legacyItemId,
      marketplaceId: undefined,
      sourceUrl: undefined,
      raw,
    };
  }

  if (/^\d+$/.test(raw)) {
    throw badRequest(
      `'${raw}' is not a valid eBay item group id: group ids are 9 to 15 digits. ` +
        'Paste the full listing URL instead.',
    );
  }

  const url = parseUrl(raw);
  if (!url) {
    throw badRequest(
      `Could not parse '${raw}' as an eBay item group. Provide the parent listing URL such as ` +
        'https://www.ebay.com/itm/142373490668, a numeric item group id, or a Browse item id ' +
        'such as v1|142373490668|0.',
    );
  }

  const fromQuery = itemGroupIdFromHref(url.search);
  const itmMatch = ITM_PATH.exec(url.pathname);
  const itemGroupId = fromQuery ?? itmMatch?.[1] ?? queryItemId(url);
  if (!itemGroupId) {
    throw badRequest(
      `'${raw}' is an eBay URL but does not carry an item group id. Item group URLs contain ` +
        '/itm/ followed by the numeric parent item id, or an item_group_id query parameter.',
    );
  }

  // Only eBay marketplace hosts imply a marketplace; the marketplace-neutral API host does not.
  const marketplaceId = /^api\./i.test(url.hostname) ? undefined : marketplaceForHost(url.hostname);
  return {
    itemGroupId,
    marketplaceId,
    ...(marketplaceId === undefined
      ? { sourceUrl: undefined }
      : { sourceUrl: canonicalUrl(url, itemGroupId) }),
    raw,
  };
};
