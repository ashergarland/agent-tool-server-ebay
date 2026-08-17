import { AppError } from '../../errors.js';
import { mapEbayHttpError, mapEbayTransportError } from '../../provider/ebay/errors.js';
import type { EbayTokenProvider, FetchLike } from '../../provider/ebay/oauth.js';

/**
 * Retrieval and caching of the ECDSA public keys eBay signs notifications with.
 *
 * The key is fetched from the official Notification API:
 *
 *   GET {apiBaseUrl}/commerce/notification/v1/public_key/{public_key_id}
 *
 * authenticated with the same application (client-credentials) access token the Browse API calls
 * already use — the existing {@link EbayTokenProvider} is reused rather than re-implemented.
 *
 * eBay explicitly asks integrators to cache the key ("one hour is recommended") because fetching
 * it per notification burns API call quota during a deletion burst.
 *
 * https://developer.ebay.com/api-docs/commerce/notification/resources/public_key/methods/getPublicKey
 */

export interface EbayPublicKey {
  /** PEM-encoded SubjectPublicKeyInfo, as returned by eBay. */
  readonly key: string;
  readonly algorithm: string | undefined;
  readonly digest: string | undefined;
}

export interface PublicKeyProvider {
  getPublicKey(keyId: string): Promise<EbayPublicKey>;
}

/** eBay recommends caching each key for about an hour. */
export const DEFAULT_PUBLIC_KEY_TTL_MS = 3_600_000;
/** Bounds memory: a hostile stream of unknown `kid` values cannot grow the cache without limit. */
export const DEFAULT_PUBLIC_KEY_CACHE_MAX_ENTRIES = 32;
/**
 * How long a failed lookup is remembered.
 *
 * The callback that drives these lookups is necessarily public, so a caller can replay a
 * well-formed signature header carrying an unknown `kid` indefinitely. Without negative caching
 * each replay would become a fresh eBay call. Short enough that a transient eBay failure recovers
 * quickly — eBay redelivers an unacknowledged notification for 24 hours — and long enough that a
 * replay costs nothing.
 */
export const DEFAULT_PUBLIC_KEY_FAILURE_TTL_MS = 60_000;
/**
 * Ceiling on outbound key lookups per window, counted globally rather than per caller.
 *
 * A per-address limit cannot bound this: the server runs behind Container Apps ingress with
 * `trustProxy` enabled, so `request.ip` comes from a caller-supplied `X-Forwarded-For` and an
 * attacker can mint a fresh bucket per request. Legitimate traffic needs roughly one lookup per
 * key per hour, so this ceiling is orders of magnitude above real demand while still keeping the
 * connector inside its eBay Notification API quota under abuse.
 */
export const DEFAULT_PUBLIC_KEY_MAX_FETCHES_PER_WINDOW = 30;
export const DEFAULT_PUBLIC_KEY_FETCH_WINDOW_MS = 60_000;

/**
 * The `kid` is interpolated into a URL path, so it is constrained to an opaque-identifier charset
 * before it is ever used. This makes path traversal and request smuggling through the key id
 * impossible regardless of what the signature header contained.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface NotificationApiPublicKeyProviderOptions {
  /** eBay REST host for the active environment, e.g. `https://api.ebay.com`. */
  readonly apiBaseUrl: string;
  readonly tokens: EbayTokenProvider;
  readonly timeoutMs: number;
  readonly ttlMs?: number;
  readonly failureTtlMs?: number;
  readonly maxEntries?: number;
  readonly maxFetchesPerWindow?: number;
  readonly fetchWindowMs?: number;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly value: EbayPublicKey;
  readonly expiresAtMs: number;
}

interface FailureEntry {
  readonly error: unknown;
  readonly expiresAtMs: number;
}

interface PublicKeyResponse {
  readonly key?: unknown;
  readonly algorithm?: unknown;
  readonly digest?: unknown;
}

export class NotificationApiPublicKeyProvider implements PublicKeyProvider {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, FailureEntry>();
  private readonly inFlight = new Map<string, Promise<EbayPublicKey>>();
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxFetchesPerWindow: number;
  private readonly fetchWindowMs: number;
  private windowStartedAtMs = Number.NEGATIVE_INFINITY;
  private fetchesInWindow = 0;

  /** Number of times a key was actually fetched from eBay; asserted on by the cache tests. */
  public fetchCount = 0;

  public constructor(private readonly options: NotificationApiPublicKeyProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? (() => Date.now());
    this.ttlMs = options.ttlMs ?? DEFAULT_PUBLIC_KEY_TTL_MS;
    this.failureTtlMs = options.failureTtlMs ?? DEFAULT_PUBLIC_KEY_FAILURE_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_PUBLIC_KEY_CACHE_MAX_ENTRIES;
    this.maxFetchesPerWindow =
      options.maxFetchesPerWindow ?? DEFAULT_PUBLIC_KEY_MAX_FETCHES_PER_WINDOW;
    this.fetchWindowMs = options.fetchWindowMs ?? DEFAULT_PUBLIC_KEY_FETCH_WINDOW_MS;
  }

  public async getPublicKey(keyId: string): Promise<EbayPublicKey> {
    if (!KEY_ID_PATTERN.test(keyId)) {
      throw new AppError('bad_request', 'The signature header carried an unusable key id.');
    }

    const cached = this.cache.get(keyId);
    if (cached && cached.expiresAtMs > this.now()) return cached.value;
    this.cache.delete(keyId);

    const failed = this.failures.get(keyId);
    if (failed && failed.expiresAtMs > this.now()) throw failed.error;
    this.failures.delete(keyId);

    // Collapse concurrent misses: a burst of notifications signed with the same key triggers one
    // request, not one per notification.
    const existing = this.inFlight.get(keyId);
    if (existing) return existing;

    // Reserved before the promise is created so an exhausted budget is not itself cached: no eBay
    // call was made, and the next window should try again.
    this.reserveFetchSlot();

    const pending = this.fetchPublicKey(keyId)
      .then((value) => {
        this.store(this.cache, keyId, { value, expiresAtMs: this.now() + this.ttlMs });
        return value;
      })
      .catch((error: unknown) => {
        this.store(this.failures, keyId, {
          error,
          expiresAtMs: this.now() + this.failureTtlMs,
        });
        throw error;
      })
      .finally(() => {
        this.inFlight.delete(keyId);
      });

    this.inFlight.set(keyId, pending);
    return pending;
  }

  /**
   * Fixed-window budget on outbound lookups. Exceeding it fails the notification with a retryable
   * error rather than issuing the call, so eBay redelivers instead of the connector exhausting its
   * Notification API quota.
   */
  private reserveFetchSlot(): void {
    const now = this.now();
    if (now - this.windowStartedAtMs >= this.fetchWindowMs) {
      this.windowStartedAtMs = now;
      this.fetchesInWindow = 0;
    }
    if (this.fetchesInWindow >= this.maxFetchesPerWindow) {
      throw new AppError(
        'upstream_error',
        'Too many eBay notification public key lookups; the signing key could not be resolved.',
        { retryable: true },
      );
    }
    this.fetchesInWindow += 1;
  }

  private store<T>(target: Map<string, T>, keyId: string, entry: T): void {
    // Simple bounded FIFO eviction. Key ids rotate rarely, so recency tracking buys nothing.
    if (target.size >= this.maxEntries) {
      const oldest = target.keys().next();
      if (!oldest.done) target.delete(oldest.value);
    }
    target.set(keyId, entry);
  }

  private async fetchPublicKey(keyId: string): Promise<EbayPublicKey> {
    const context = 'eBay notification public key';
    const url = `${this.options.apiBaseUrl.replace(/\/$/, '')}/commerce/notification/v1/public_key/${encodeURIComponent(keyId)}`;

    const token = await this.options.tokens.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    let response: Response;
    try {
      this.fetchCount += 1;
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (error) {
      throw mapEbayTransportError(error, context);
    } finally {
      clearTimeout(timer);
    }

    const payload: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      if (response.status === 401) this.options.tokens.invalidate();
      throw mapEbayHttpError({ status: response.status, body: payload }, context);
    }

    const parsed = payload as PublicKeyResponse | undefined;
    if (typeof parsed?.key !== 'string' || parsed.key.length === 0) {
      throw new AppError('upstream_error', `${context}: eBay returned no key material`, {
        retryable: true,
      });
    }

    return {
      key: parsed.key,
      algorithm: typeof parsed.algorithm === 'string' ? parsed.algorithm : undefined,
      digest: typeof parsed.digest === 'string' ? parsed.digest : undefined,
    };
  }
}
