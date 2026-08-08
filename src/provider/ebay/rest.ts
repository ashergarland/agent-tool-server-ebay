import { AppError } from '../../errors.js';
import { isRetryableStatus, mapEbayHttpError, mapEbayTransportError } from './errors.js';
import type { EbayTokenProvider, FetchLike } from './oauth.js';
import type { MarketplaceId } from './marketplaces.js';

/**
 * Thin authenticated reader for the eBay Buy APIs. It only performs GETs — the connector is
 * strictly read-only — and centralises the four things every eBay call needs: the bearer token,
 * the marketplace header, the buyer context header and retry/backoff behaviour.
 */

export interface EbayRestClientOptions {
  readonly baseUrl: string;
  readonly tokens: EbayTokenProvider;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  readonly affiliateCampaignId?: string | undefined;
  readonly fetchImpl?: FetchLike;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface EbayGetOptions {
  readonly marketplaceId: MarketplaceId;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** Context used in error messages, e.g. `getListing`. */
  readonly context: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Builds the `X-EBAY-C-ENDUSERCTX` header. eBay only returns `shippingOptions` for listings with
 * calculated shipping when a contextual location is supplied, and only populates affiliate URLs
 * when a campaign id is supplied.
 *
 * The `contextualLocation` value is itself URL-encoded inside the header value, exactly as the
 * eBay documentation shows (`contextualLocation=country%3DUS%2Czip%3D19406`).
 */
export const buildEndUserContext = (options: {
  readonly deliveryCountry?: string | undefined;
  readonly deliveryPostalCode?: string | undefined;
  readonly affiliateCampaignId?: string | undefined;
}): string | undefined => {
  const parts: string[] = [];
  if (options.affiliateCampaignId) {
    parts.push(`affiliateCampaignId=${options.affiliateCampaignId}`);
  }
  if (options.deliveryCountry) {
    const location = options.deliveryPostalCode
      ? `country=${options.deliveryCountry},zip=${options.deliveryPostalCode}`
      : `country=${options.deliveryCountry}`;
    parts.push(`contextualLocation=${encodeURIComponent(location)}`);
  }
  return parts.length > 0 ? parts.join(',') : undefined;
};

export class EbayRestClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly endUserContext: string | undefined;

  public constructor(private readonly options: EbayRestClientOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.endUserContext = buildEndUserContext(options);
  }

  private buildUrl(path: string, query: EbayGetOptions['query']): string {
    const url = new URL(path.replace(/^\//, ''), `${this.options.baseUrl.replace(/\/$/, '')}/`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async headers(marketplaceId: MarketplaceId): Promise<Record<string, string>> {
    const token = await this.options.tokens.getToken();
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'X-EBAY-C-MARKETPLACE-ID': marketplaceId,
      ...(this.endUserContext === undefined ? {} : { 'X-EBAY-C-ENDUSERCTX': this.endUserContext }),
    };
  }

  /**
   * Performs an authenticated GET with bounded retries. A 401 invalidates the cached token once
   * so that an expired or revoked token is recovered from without failing the caller's request.
   */
  public async get<T>(path: string, options: EbayGetOptions): Promise<T> {
    const url = this.buildUrl(path, options.query);
    let lastError: AppError | undefined;
    let retriedAfterUnauthorized = false;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: await this.headers(options.marketplaceId),
          signal: controller.signal,
        });
      } catch (error) {
        lastError = mapEbayTransportError(error, options.context);
        if (!lastError.retryable || attempt === this.options.maxRetries) throw lastError;
        await this.backoff(attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        if (body === undefined) {
          throw new AppError('upstream_error', `${options.context}: eBay returned an empty body`, {
            retryable: true,
          });
        }
        return body as T;
      }

      const body: unknown = await response.json().catch(() => undefined);
      const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
      lastError = mapEbayHttpError(
        {
          status: response.status,
          body,
          retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
        },
        options.context,
      );

      if (response.status === 401 && !retriedAfterUnauthorized) {
        // The application token may simply have been revoked or rotated early; try once more
        // with a freshly minted one before surfacing the failure.
        retriedAfterUnauthorized = true;
        this.options.tokens.invalidate();
        continue;
      }

      if (!isRetryableStatus(response.status) || attempt === this.options.maxRetries) {
        throw lastError;
      }
      await this.backoff(attempt, Number.isFinite(retryAfter) ? retryAfter : undefined);
    }

    throw lastError ?? new AppError('upstream_error', `${options.context}: eBay request failed`);
  }

  /** Exponential backoff, honouring `Retry-After` when eBay supplies it. */
  private async backoff(attempt: number, retryAfterSeconds?: number): Promise<void> {
    const base = this.options.retryBaseDelayMs * 2 ** attempt;
    const delay = retryAfterSeconds === undefined ? base : Math.max(base, retryAfterSeconds * 1000);
    if (delay > 0) await this.sleep(delay);
  }
}
