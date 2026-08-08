import type { FetchLike } from '../../src/provider/ebay/oauth.js';

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

export interface StubResponse {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  /** When set, the fetch rejects with this error instead of responding. */
  readonly error?: Error;
}

export interface FakeFetch {
  readonly fetchImpl: FetchLike;
  readonly requests: RecordedRequest[];
}

const toResponse = (stub: StubResponse): Response =>
  new Response(stub.body === undefined ? '' : JSON.stringify(stub.body), {
    status: stub.status ?? 200,
    headers: { 'content-type': 'application/json', ...stub.headers },
  });

/**
 * Scripted fetch. Each call consumes the next stub; the final stub is reused once exhausted so a
 * retry test does not have to enumerate every attempt.
 */
export const createFakeFetch = (stubs: readonly StubResponse[]): FakeFetch => {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetchImpl: FetchLike = (url, init) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    requests.push({
      url,
      method: init.method ?? 'GET',
      headers,
      body: typeof init.body === 'string' ? init.body : undefined,
    });

    const stub = stubs[Math.min(index, stubs.length - 1)] ?? {};
    index += 1;
    if (stub.error !== undefined) return Promise.reject(stub.error);
    return Promise.resolve(toResponse(stub));
  };

  return { fetchImpl, requests };
};

/** A successful eBay OAuth client-credentials token response. */
export const tokenResponse = (token = 'token-1', expiresIn = 7200): StubResponse => ({
  status: 200,
  body: { access_token: token, expires_in: expiresIn, token_type: 'Application Access Token' },
});

/** eBay's documented REST error envelope. */
export const ebayErrorBody = (
  errorId: number,
  message: string,
  extra: Record<string, unknown> = {},
): unknown => ({
  errors: [
    {
      errorId,
      domain: 'API_BROWSE',
      category: 'REQUEST',
      message,
      longMessage: message,
      ...extra,
    },
  ],
});
