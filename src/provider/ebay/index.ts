import type { AppConfig } from '../../config/index.js';
import { AppError, badRequest } from '../../errors.js';
import type {
  EbayProvider,
  GetListingInput,
  Listing,
  SearchInput,
  SearchResult,
} from '../types.js';
import { buildSearchFilter, toEbaySort } from './filters.js';
import {
  normaliseListing,
  normaliseListingSummary,
  normaliseTotal,
  normaliseWarnings,
} from './normalize.js';
import { EbayTokenProvider, type FetchLike } from './oauth.js';
import { EbayRestClient } from './rest.js';

export { EbayTokenProvider, EbayRestClient };
export * from './marketplaces.js';
export * from './urls.js';
export { buildSearchFilter, toEbaySort } from './filters.js';
export { buildEndUserContext } from './rest.js';
export {
  addMoney,
  deliveredTotal,
  lowestShippingCost,
  normaliseListing,
  normaliseListingSummary,
  secondsUntil,
  toMoney,
} from './normalize.js';
export { describeEbayErrors, mapEbayHttpError, mapEbayTransportError } from './errors.js';

/** Ask eBay for the catalogue product container so EPID/MPN/GTIN are available for comparables. */
const GET_ITEM_FIELDGROUPS = 'PRODUCT';

interface SearchResponse {
  readonly itemSummaries?: unknown;
  readonly total?: unknown;
  readonly warnings?: unknown;
}

/**
 * The eBay Browse API implementation of the {@link EbayProvider} port. This is the only module in
 * the codebase that knows eBay's REST paths, query parameters and payload shapes.
 */
export class BrowseApiProvider implements EbayProvider {
  public constructor(private readonly client: EbayRestClient) {}

  public async getListing(input: GetListingInput): Promise<Listing> {
    const payload = input.itemId
      ? await this.client.get<unknown>(`/buy/browse/v1/item/${encodeURIComponent(input.itemId)}`, {
          marketplaceId: input.marketplaceId,
          query: { fieldgroups: GET_ITEM_FIELDGROUPS },
          context: 'getListing',
        })
      : await this.getByLegacyId(input);

    return normaliseListing(payload, { marketplaceId: input.marketplaceId });
  }

  private getByLegacyId(input: GetListingInput): Promise<unknown> {
    if (!input.legacyItemId) {
      throw badRequest('An eBay item id or legacy item id is required to fetch a listing.');
    }
    return this.client.get<unknown>('/buy/browse/v1/item/get_item_by_legacy_id', {
      marketplaceId: input.marketplaceId,
      query: {
        legacy_item_id: input.legacyItemId,
        legacy_variation_id: input.legacyVariationId,
        fieldgroups: GET_ITEM_FIELDGROUPS,
      },
      context: 'getListing',
    });
  }

  public async searchListings(input: SearchInput): Promise<SearchResult> {
    if (!input.query && !input.epid && !input.gtin && !input.categoryIds?.length) {
      throw badRequest(
        'A search needs at least one of: keywords, category ids, an EPID or a GTIN.',
      );
    }

    const { filter, params } = buildSearchFilter(input);
    const payload = await this.client.get<SearchResponse>('/buy/browse/v1/item_summary/search', {
      marketplaceId: input.marketplaceId,
      query: {
        q: input.query,
        ...params,
        filter,
        sort: toEbaySort(input.sort),
        limit: input.limit,
        offset: input.offset,
      },
      context: 'searchListings',
    });

    const summaries = Array.isArray(payload.itemSummaries) ? payload.itemSummaries : [];
    return {
      listings: summaries.map((summary) =>
        normaliseListingSummary(summary, { marketplaceId: input.marketplaceId }),
      ),
      total: normaliseTotal(payload),
      limit: input.limit,
      offset: input.offset,
      appliedFilter: filter,
      appliedQuery: input.query,
      warnings: normaliseWarnings(payload),
    };
  }
}

export interface CreateEbayProviderOptions {
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Builds the real eBay provider. Credentials are required: a connector that cannot authenticate
 * would fail every tool call with an opaque error, so it fails loudly at construction instead.
 */
export const createEbayProvider = (
  config: AppConfig,
  options: CreateEbayProviderOptions = {},
): EbayProvider => {
  const { clientId, clientSecret } = config.ebay;
  if (!clientId || !clientSecret) {
    throw new AppError(
      'internal_error',
      'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be configured before the eBay provider can be used.',
    );
  }

  const tokens = new EbayTokenProvider({
    tokenUrl: config.ebay.oauthTokenUrl,
    clientId,
    clientSecret,
    scopes: config.ebay.scopes,
    refreshSkewMs: config.ebay.tokenRefreshSkewMs,
    timeoutMs: config.ebay.requestTimeoutMs,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const client = new EbayRestClient({
    baseUrl: config.ebay.apiBaseUrl,
    tokens,
    timeoutMs: config.ebay.requestTimeoutMs,
    maxRetries: config.ebay.maxRetries,
    retryBaseDelayMs: config.ebay.retryBaseDelayMs,
    deliveryCountry: config.ebay.deliveryCountry,
    deliveryPostalCode: config.ebay.deliveryPostalCode,
    affiliateCampaignId: config.ebay.affiliateCampaignId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });

  return new BrowseApiProvider(client);
};
