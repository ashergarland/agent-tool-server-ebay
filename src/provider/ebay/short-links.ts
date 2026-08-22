import { AppError, badRequest } from '../../errors.js';
import { mapEbayTransportError } from './errors.js';
import type { FetchLike } from './oauth.js';

/** The eBay app currently emits mobile share links on this exact host and path family. */
const SHORT_LINK_HOST = 'ebay.io';
const SHORT_LINK_PATH = /^\/m\/[A-Za-z0-9_-]+\/?$/;

/**
 * The observed `ebay.io` redirect goes directly to this marketplace host. Keeping this list
 * explicit prevents the resolver from becoming a generic URL fetcher when a redirect is malformed
 * or attacker-controlled.
 */
const ALLOWED_DESTINATION_HOSTS: ReadonlySet<string> = new Set(['www.ebay.com']);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_REDIRECTS = 3;

export interface ItemReferenceResolver {
  resolve(input: string): Promise<string>;
}

export interface EbayShortLinkResolverOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

const hasSafeAuthority = (url: URL): boolean =>
  url.protocol === 'https:' &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.port.length === 0;

const isShortLinkUrl = (url: URL): boolean =>
  hasSafeAuthority(url) &&
  url.hostname.toLowerCase() === SHORT_LINK_HOST &&
  SHORT_LINK_PATH.test(url.pathname);

/** True only for the HTTPS `ebay.io/m/<token>` links emitted by the eBay mobile app. */
export const isEbayShortLink = (input: string): boolean => {
  const url = parseUrl(input.trim());
  return url !== undefined && isShortLinkUrl(url);
};

const cleanUrl = (url: URL): URL => {
  const cleaned = new URL(url.href);
  // Fragments are never sent over HTTP and should not affect loop detection.
  cleaned.hash = '';
  return cleaned;
};

const parseRedirectLocation = (location: string, current: URL): URL => {
  let destination: URL;
  try {
    destination = cleanUrl(new URL(location, current));
  } catch {
    throw badRequest('The eBay mobile share link returned a malformed redirect location.');
  }

  if (!hasSafeAuthority(destination)) {
    throw badRequest(
      'The eBay mobile share link redirected to an unsafe URL. Redirects must use HTTPS, the ' +
        'default port, and no embedded credentials.',
    );
  }
  return destination;
};

const unsupportedDestination = (destination: URL): AppError =>
  badRequest(
    `The eBay mobile share link redirected to unsupported host '${destination.hostname}'. ` +
      'Only the verified eBay listing destination is permitted.',
  );

/**
 * Resolves eBay mobile share links without sharing cookies or connector/eBay credentials.
 *
 * Redirects are handled manually so every hop can be checked before another request is made. A
 * normal eBay listing URL is returned untouched by the network layer and then parsed by the same
 * synchronous `parseItemReference()` flow as any caller-supplied long URL.
 */
export class EbayShortLinkResolver implements ItemReferenceResolver {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  public constructor(options: EbayShortLinkResolverOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('eBay short-link timeoutMs must be greater than zero.');
    }
    if (!Number.isInteger(this.maxRedirects) || this.maxRedirects <= 0) {
      throw new RangeError('eBay short-link maxRedirects must be a positive integer.');
    }
  }

  public async resolve(input: string): Promise<string> {
    const initial = parseUrl(input.trim());
    if (initial === undefined || !isShortLinkUrl(initial)) return input;

    let current = cleanUrl(initial);
    const visited = new Set<string>();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      for (let redirectCount = 0; redirectCount < this.maxRedirects; redirectCount += 1) {
        if (visited.has(current.href)) {
          throw badRequest('The eBay mobile share link contains a redirect loop.');
        }
        visited.add(current.href);

        const response = await this.fetchRedirect(current, controller.signal);
        if (!REDIRECT_STATUSES.has(response.status)) {
          throw new AppError(
            'upstream_error',
            `eBay mobile share link resolution expected a redirect but received HTTP ${response.status}.`,
            {
              details: { status: response.status },
              retryable: response.status >= 500,
            },
          );
        }

        const location = response.headers.get('location')?.trim();
        if (!location) {
          throw new AppError(
            'upstream_error',
            'eBay mobile share link resolution received a redirect without a Location header.',
            { details: { status: response.status }, retryable: false },
          );
        }

        const destination = parseRedirectLocation(location, current);
        const host = destination.hostname.toLowerCase();

        if (ALLOWED_DESTINATION_HOSTS.has(host)) return destination.href;
        if (!isShortLinkUrl(destination)) throw unsupportedDestination(destination);
        if (visited.has(destination.href)) {
          throw badRequest('The eBay mobile share link contains a redirect loop.');
        }

        current = destination;
      }

      throw badRequest(
        `The eBay mobile share link exceeded the ${this.maxRedirects}-redirect safety limit.`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchRedirect(url: URL, signal: AbortSignal): Promise<Response> {
    try {
      return await this.fetchImpl(url.href, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
      });
    } catch (error) {
      throw mapEbayTransportError(error, 'eBay mobile share link resolution');
    }
  }
}
