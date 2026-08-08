import { AppError } from '../../errors.js';
import { describeEbayErrors, mapEbayTransportError } from './errors.js';

/**
 * eBay OAuth **client credentials** grant, which yields an *application* access token. That is
 * the correct flow for the Browse API's public data: no eBay user is involved, so there is no
 * refresh token and no user consent step.
 *
 * https://developer.ebay.com/api-docs/static/oauth-client-credentials-grant.html
 *
 * eBay's own guidance is explicit that the token must be cached and reused for its lifetime
 * ("store this token in a static variable and re-use the token while it is valid"), so this
 * class keeps exactly one token in memory, renews it a configurable interval *before* it
 * expires, and collapses concurrent renewals onto a single in-flight request.
 */

export interface TokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly token_type?: unknown;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EbayTokenProviderOptions {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** Renew this many milliseconds before the token actually expires. */
  readonly refreshSkewMs: number;
  readonly timeoutMs: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** Never treat a token as usable for longer than eBay said, even if the skew is misconfigured. */
const MIN_LIFETIME_MS = 1_000;

export class EbayTokenProvider {
  private cached: CachedToken | undefined;
  private inFlight: Promise<string> | undefined;

  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  public constructor(private readonly options: EbayTokenProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
  }

  /** Number of times a token was actually fetched from eBay; used by tests and diagnostics. */
  public fetchCount = 0;

  /**
   * Returns a valid application access token, fetching one only when the cache is empty or the
   * cached token is inside the refresh window.
   */
  public async getToken(): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAtMs > this.now()) return cached.token;

    // Collapse concurrent misses so a burst of tool calls triggers a single token request.
    this.inFlight ??= this.requestToken().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** Drops the cached token so the next call re-authenticates. Used after a 401 from eBay. */
  public invalidate(): void {
    this.cached = undefined;
  }

  private authorizationHeader(): string {
    const basic = Buffer.from(
      `${this.options.clientId}:${this.options.clientSecret}`,
      'utf8',
    ).toString('base64');
    return `Basic ${basic}`;
  }

  private async requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: this.options.scopes.join(' '),
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      this.fetchCount += 1;
      response = await this.fetchImpl(this.options.tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          authorization: this.authorizationHeader(),
        },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (error) {
      throw mapEbayTransportError(error, 'eBay OAuth token request');
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const summary = describeEbayErrors(payload);
      const suffix = summary ? ` (${summary})` : '';
      if (response.status === 400 || response.status === 401) {
        // A rejected client credential is a deployment problem, not a caller problem, so it is
        // surfaced as an upstream failure rather than as a 401 to ChatGPT.
        throw new AppError(
          'upstream_error',
          `eBay rejected the connector's application credentials${suffix}. ` +
            'Verify EBAY_CLIENT_ID and EBAY_CLIENT_SECRET and that they match EBAY_ENVIRONMENT.',
          { details: { status: response.status }, retryable: false },
        );
      }
      if (response.status === 429) {
        throw new AppError('rate_limited', `eBay throttled the OAuth token request${suffix}`, {
          details: { status: response.status },
          retryable: true,
        });
      }
      throw new AppError('upstream_error', `eBay OAuth token request failed${suffix}`, {
        details: { status: response.status },
        retryable: response.status >= 500,
      });
    }

    const parsed = payload as TokenResponse | undefined;
    const token = typeof parsed?.access_token === 'string' ? parsed.access_token : undefined;
    if (!token) {
      throw new AppError('upstream_error', 'eBay OAuth response did not contain an access token', {
        retryable: true,
      });
    }

    const expiresInSeconds =
      typeof parsed?.expires_in === 'number' && Number.isFinite(parsed.expires_in)
        ? parsed.expires_in
        : 7200;
    const lifetimeMs = Math.max(
      MIN_LIFETIME_MS,
      expiresInSeconds * 1000 - this.options.refreshSkewMs,
    );

    this.cached = { token, expiresAtMs: this.now() + lifetimeMs };
    return token;
  }
}
