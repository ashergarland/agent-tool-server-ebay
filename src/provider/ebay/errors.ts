import { AppError } from '../../errors.js';

/**
 * eBay's standard REST error envelope:
 * `{ errors: [{ errorId, domain, subdomain, category, message, longMessage, parameters }] }`.
 */
export interface EbayApiError {
  readonly errorId?: number;
  readonly domain?: string;
  readonly subdomain?: string;
  readonly category?: string;
  readonly message?: string;
  readonly longMessage?: string;
  readonly parameters?: readonly { name?: string; value?: string }[];
}

export interface EbayErrorEnvelope {
  readonly errors?: readonly EbayApiError[];
  readonly warnings?: readonly EbayApiError[];
  /** OAuth failures use the OAuth 2.0 error shape rather than the REST envelope. */
  readonly error?: string;
  readonly error_description?: string;
}

const asEnvelope = (body: unknown): EbayErrorEnvelope =>
  typeof body === 'object' && body !== null ? body : {};

/** Extracts a human-readable summary from either eBay error shape. */
export const describeEbayErrors = (body: unknown): string | undefined => {
  const envelope = asEnvelope(body);
  const first = envelope.errors?.[0];
  if (first) {
    const text = first.longMessage ?? first.message;
    return text
      ? `${text}${first.errorId === undefined ? '' : ` (errorId ${first.errorId})`}`
      : undefined;
  }
  if (envelope.error) {
    return envelope.error_description
      ? `${envelope.error}: ${envelope.error_description}`
      : envelope.error;
  }
  return undefined;
};

/** The error ids eBay returns, kept for the `details` payload so failures stay diagnosable. */
export const ebayErrorIds = (body: unknown): readonly number[] =>
  (asEnvelope(body).errors ?? [])
    .map((error) => error.errorId)
    .filter((id): id is number => typeof id === 'number');

/**
 * True when the message eBay returned indicates the listing exists but is no longer available
 * (ended, sold out, or withdrawn) rather than never having existed.
 */
const looksUnavailable = (summary: string | undefined): boolean =>
  summary !== undefined &&
  /\b(ended|unavailable|no longer available|not available)\b/i.test(summary);

export interface EbayHttpFailure {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds?: number | undefined;
}

/**
 * Translates an eBay REST failure into the connector's transport-agnostic error taxonomy.
 * eBay status codes and error ids never escape this module.
 */
export const mapEbayHttpError = (failure: EbayHttpFailure, context: string): AppError => {
  const summary = describeEbayErrors(failure.body);
  const details = {
    context,
    status: failure.status,
    ebayErrorIds: ebayErrorIds(failure.body),
    ...(failure.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSeconds: failure.retryAfterSeconds }),
  };
  const message = summary
    ? `${context}: ${summary}`
    : `${context}: eBay returned ${failure.status}`;

  switch (failure.status) {
    case 400:
      // eBay uses 400 both for malformed requests and for "this listing has ended".
      return looksUnavailable(summary)
        ? new AppError('not_found', message, { details })
        : new AppError('bad_request', message, { details });
    case 401:
      return new AppError(
        'upstream_error',
        `${context}: eBay rejected the connector's application token${summary ? ` (${summary})` : ''}`,
        { details, retryable: true },
      );
    case 403:
      return new AppError(
        'forbidden',
        `${context}: the eBay application is not authorised for this call${summary ? ` (${summary})` : ''}. ` +
          'Check that the eBay developer account has Browse API access for this marketplace.',
        { details },
      );
    case 404:
      return new AppError('not_found', message, { details });
    case 409:
      return new AppError('conflict', message, { details });
    case 429:
      return new AppError('rate_limited', `${context}: eBay throttled the request`, {
        details,
        retryable: true,
      });
    case 408:
    case 504:
      return new AppError('timeout', message, { details });
    default:
      return new AppError(failure.status >= 500 ? 'upstream_error' : 'bad_request', message, {
        details,
      });
  }
};

/** Translates a transport-level failure (DNS, TLS, socket, abort) into the taxonomy. */
export const mapEbayTransportError = (error: unknown, context: string): AppError => {
  if (error instanceof AppError) return error;

  const name = error instanceof Error ? error.name : undefined;
  if (name === 'AbortError' || name === 'TimeoutError') {
    return new AppError('timeout', `${context}: the eBay request timed out`, { cause: error });
  }
  const message = error instanceof Error ? error.message : 'unknown transport failure';
  return new AppError('upstream_error', `${context}: could not reach eBay (${message})`, {
    cause: error,
    retryable: true,
  });
};

/** Status codes worth retrying: eBay throttling and transient server-side failures. */
export const isRetryableStatus = (status: number): boolean =>
  status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
