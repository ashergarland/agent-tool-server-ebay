import { describe, expect, it } from 'vitest';
import { EbayTokenProvider } from '../../src/provider/ebay/oauth.js';
import { createFakeFetch, tokenResponse } from '../helpers/fake-fetch.js';

const baseOptions = {
  tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  scopes: ['https://api.ebay.com/oauth/api_scope'],
  refreshSkewMs: 300_000,
  timeoutMs: 5_000,
};

const buildProvider = (
  stubs: Parameters<typeof createFakeFetch>[0],
  clock: { nowMs: number },
  overrides: Partial<typeof baseOptions> = {},
) => {
  const fetch = createFakeFetch(stubs);
  const provider = new EbayTokenProvider({
    ...baseOptions,
    ...overrides,
    fetchImpl: fetch.fetchImpl,
    now: () => clock.nowMs,
  });
  return { provider, fetch };
};

describe('EbayTokenProvider — request shape', () => {
  it('uses the client credentials grant with HTTP basic authentication', async () => {
    const clock = { nowMs: 0 };
    const { provider, fetch } = buildProvider([tokenResponse()], clock);

    await provider.getToken();

    const request = fetch.requests[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(baseOptions.tokenUrl);
    expect(request?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(request?.headers['authorization']).toBe(
      `Basic ${Buffer.from('client-id:client-secret').toString('base64')}`,
    );

    const body = new URLSearchParams(request?.body ?? '');
    expect(body.get('grant_type')).toBe('client_credentials');
    expect(body.get('scope')).toBe('https://api.ebay.com/oauth/api_scope');
  });

  it('joins multiple scopes with a space', async () => {
    const clock = { nowMs: 0 };
    const { provider, fetch } = buildProvider([tokenResponse()], clock, {
      scopes: ['scope-a', 'scope-b'],
    });

    await provider.getToken();
    expect(new URLSearchParams(fetch.requests[0]?.body ?? '').get('scope')).toBe('scope-a scope-b');
  });
});

describe('EbayTokenProvider — caching', () => {
  it('reuses a cached token instead of fetching per request', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([tokenResponse('token-1')], clock);

    expect(await provider.getToken()).toBe('token-1');
    expect(await provider.getToken()).toBe('token-1');
    expect(await provider.getToken()).toBe('token-1');
    expect(provider.fetchCount).toBe(1);
  });

  it('refreshes before the token actually expires', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([tokenResponse('token-1'), tokenResponse('token-2')], clock);

    await provider.getToken();
    // 7200s lifetime minus a 300s skew: still cached at 6899s, renewed at 6901s.
    clock.nowMs = 6_899_000;
    expect(await provider.getToken()).toBe('token-1');
    expect(provider.fetchCount).toBe(1);

    clock.nowMs = 6_901_000;
    expect(await provider.getToken()).toBe('token-2');
    expect(provider.fetchCount).toBe(2);
  });

  it('honours a short expires_in from eBay', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider(
      [tokenResponse('token-1', 60), tokenResponse('token-2', 60)],
      clock,
      { refreshSkewMs: 10_000 },
    );

    await provider.getToken();
    clock.nowMs = 49_000;
    expect(await provider.getToken()).toBe('token-1');
    clock.nowMs = 51_000;
    expect(await provider.getToken()).toBe('token-2');
  });

  it('never caches a token for less than a second even with an absurd skew', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([tokenResponse('token-1', 60)], clock, {
      refreshSkewMs: 3_600_000,
    });

    await provider.getToken();
    clock.nowMs = 500;
    expect(await provider.getToken()).toBe('token-1');
    expect(provider.fetchCount).toBe(1);
  });

  it('defaults to a two hour lifetime when eBay omits expires_in', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ status: 200, body: { access_token: 'token-1' } }], clock);

    await provider.getToken();
    clock.nowMs = 6_800_000;
    await provider.getToken();
    expect(provider.fetchCount).toBe(1);
  });

  it('collapses concurrent cache misses onto a single request', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([tokenResponse('token-1')], clock);

    const tokens = await Promise.all([
      provider.getToken(),
      provider.getToken(),
      provider.getToken(),
    ]);

    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(provider.fetchCount).toBe(1);
  });

  it('re-authenticates after invalidate()', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([tokenResponse('token-1'), tokenResponse('token-2')], clock);

    expect(await provider.getToken()).toBe('token-1');
    provider.invalidate();
    expect(await provider.getToken()).toBe('token-2');
    expect(provider.fetchCount).toBe(2);
  });

  it('does not cache a failed attempt', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider(
      [{ status: 500, body: { errors: [{ errorId: 1, message: 'boom' }] } }, tokenResponse('ok')],
      clock,
    );

    await expect(provider.getToken()).rejects.toThrowError(
      expect.objectContaining({ code: 'upstream_error' }) as unknown,
    );
    expect(await provider.getToken()).toBe('ok');
  });
});

describe('EbayTokenProvider — failures', () => {
  it('reports rejected credentials as a non-retryable upstream error', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider(
      [{ status: 401, body: { error: 'invalid_client', error_description: 'bad credentials' } }],
      clock,
    );

    await expect(provider.getToken()).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: false,
    });
  });

  it('mentions the configuration variables the operator must check', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ status: 400, body: { error: 'invalid_scope' } }], clock);

    await expect(provider.getToken()).rejects.toThrow(/EBAY_CLIENT_ID/);
  });

  it('maps an OAuth throttle to rate_limited', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ status: 429, body: {} }], clock);

    await expect(provider.getToken()).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('rejects a 200 response with no access token', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ status: 200, body: { token_type: 'Bearer' } }], clock);

    await expect(provider.getToken()).rejects.toThrow(/did not contain an access token/);
  });

  it('maps a transport failure to a retryable upstream error', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ error: new Error('ECONNRESET') }], clock);

    await expect(provider.getToken()).rejects.toMatchObject({
      code: 'upstream_error',
      retryable: true,
    });
  });

  it('maps an abort to a timeout', async () => {
    const clock = { nowMs: 0 };
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const { provider } = buildProvider([{ error: abort }], clock);

    await expect(provider.getToken()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('never puts the client secret into the error message', async () => {
    const clock = { nowMs: 0 };
    const { provider } = buildProvider([{ status: 401, body: {} }], clock);

    await expect(provider.getToken()).rejects.toSatisfy(
      (error: Error) => !error.message.includes('client-secret'),
    );
  });
});
