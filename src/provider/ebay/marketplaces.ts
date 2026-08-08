/**
 * eBay marketplace identifiers (`X-EBAY-C-MARKETPLACE-ID`) and the mapping from the public eBay
 * site hostnames a user is likely to paste to the marketplace the Browse API must be called with.
 *
 * The list is restricted to the marketplaces eBay documents as supported by the **Buy** APIs
 * (https://developer.ebay.com/api-docs/buy/static/ref-marketplace-supported.html). eBay operates
 * further country sites, but sending their marketplace ids to the Browse API produces an opaque
 * upstream failure, so the connector rejects them early with a clear message instead.
 */
export const MARKETPLACE_IDS = [
  'EBAY_AT',
  'EBAY_AU',
  'EBAY_BE',
  'EBAY_CA',
  'EBAY_CH',
  'EBAY_DE',
  'EBAY_ES',
  'EBAY_FR',
  'EBAY_GB',
  'EBAY_HK',
  'EBAY_IE',
  'EBAY_IT',
  'EBAY_NL',
  'EBAY_PL',
  'EBAY_SG',
  'EBAY_US',
] as const;

export type MarketplaceId = (typeof MARKETPLACE_IDS)[number];

export const isMarketplaceId = (value: string): value is MarketplaceId =>
  (MARKETPLACE_IDS as readonly string[]).includes(value);

/**
 * Registrable eBay domain -> marketplace. Keys are the domain without any leading
 * country/language label (`www.`, `m.`, `cafr.`, `benl.`, `cgi.`, ...), which is stripped by
 * {@link marketplaceForHost}. Both spellings are listed where eBay operates two
 * (for example `ebay.be` and `ebay.com.be`).
 */
const MARKETPLACE_BY_DOMAIN: ReadonlyMap<string, MarketplaceId> = new Map([
  ['ebay.com', 'EBAY_US'],
  ['ebay.co.uk', 'EBAY_GB'],
  ['ebay.de', 'EBAY_DE'],
  ['ebay.com.au', 'EBAY_AU'],
  ['ebay.ca', 'EBAY_CA'],
  ['ebay.fr', 'EBAY_FR'],
  ['ebay.it', 'EBAY_IT'],
  ['ebay.es', 'EBAY_ES'],
  ['ebay.at', 'EBAY_AT'],
  ['ebay.ch', 'EBAY_CH'],
  ['ebay.ie', 'EBAY_IE'],
  ['ebay.nl', 'EBAY_NL'],
  ['ebay.be', 'EBAY_BE'],
  ['ebay.com.be', 'EBAY_BE'],
  ['ebay.pl', 'EBAY_PL'],
  ['ebay.com.hk', 'EBAY_HK'],
  ['ebay.com.sg', 'EBAY_SG'],
  ['ebay.sg', 'EBAY_SG'],
] satisfies readonly (readonly [string, MarketplaceId])[]);

/**
 * eBay-owned hostnames that are not a marketplace site of their own. Listings reached through
 * them resolve to the US marketplace.
 */
const US_ALIASES: ReadonlySet<string> = new Set(['ebaymotors.com', 'ebay.us']);

/**
 * Resolves the marketplace a hostname belongs to, or `undefined` when the host is not a
 * recognised eBay site. Subdomains such as `www.`, `m.`, `cgi.`, `cafr.` and `benl.` are ignored.
 */
export const marketplaceForHost = (hostname: string): MarketplaceId | undefined => {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host.length === 0) return undefined;

  const labels = host.split('.');
  // Walk from the full host inwards so that `ebay.com.au` is preferred over `ebay.com`, and stop
  // before the public suffix so that a lookalike such as `notebay.com` can never match.
  for (let start = 0; start < labels.length - 1; start += 1) {
    const candidate = labels.slice(start).join('.');
    const marketplace = MARKETPLACE_BY_DOMAIN.get(candidate);
    if (marketplace) return marketplace;
    if (US_ALIASES.has(candidate)) return 'EBAY_US';
  }
  return undefined;
};

/** True when the hostname belongs to a Buy-API-supported eBay site. */
export const isEbayHost = (hostname: string): boolean => marketplaceForHost(hostname) !== undefined;
