import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUBLIC_KEY_FAILURE_TTL_MS,
  DEFAULT_PUBLIC_KEY_FETCH_WINDOW_MS,
  DEFAULT_PUBLIC_KEY_TTL_MS,
  NotificationApiPublicKeyProvider,
} from '../../../src/compliance/ebay-account-deletion/public-keys.js';
import { isAppError } from '../../../src/errors.js';
import { EbayTokenProvider } from '../../../src/provider/ebay/oauth.js';
import { createFakeFetch, ebayErrorBody, tokenResponse } from '../../helpers/fake-fetch.js';
import type { StubResponse } from '../../helpers/fake-fetch.js';
import { TEST_KEY_ID, testPublicKeyAsEbayReturnsIt } from '../../helpers/ebay-signature.js';

const KEY_BODY: StubResponse = {
  status: 200,
  body: { key: testPublicKeyAsEbayReturnsIt, algorithm: 'ECDSA', digest: 'SHA1' },
};

interface Harness {
  readonly provider: NotificationApiPublicKeyProvider;
  readonly requests: { url: string }[];
  readonly advance: (ms: number) => void;
}

const harness = (
  stubs: readonly StubResponse[],
  overrides: Partial<{ ttlMs: number; maxFetchesPerWindow: number }> = {},
): Harness => {
  let clock = 1_000;
  const now = (): number => clock;
  const fake = createFakeFetch([tokenResponse(), ...stubs]);

  const provider = new NotificationApiPublicKeyProvider({
    apiBaseUrl: 'https://api.ebay.com',
    tokens: new EbayTokenProvider({
      tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scopes: ['https://api.ebay.com/oauth/api_scope'],
      refreshSkewMs: 0,
      timeoutMs: 1_000,
      fetchImpl: fake.fetchImpl,
      now,
    }),
    timeoutMs: 1_000,
    fetchImpl: fake.fetchImpl,
    now,
    ...overrides,
  });

  return {
    provider,
    requests: fake.requests,
    advance: (ms) => {
      clock += ms;
    },
  };
};

describe('NotificationApiPublicKeyProvider', () => {
  it('fetches the key from the official Notification API with an application token', async () => {
    const { provider, requests } = harness([KEY_BODY]);
    const key = await provider.getPublicKey(TEST_KEY_ID);

    expect(key.key).toBe(testPublicKeyAsEbayReturnsIt);
    expect(key.algorithm).toBe('ECDSA');

    const keyRequest = requests.at(-1);
    expect(keyRequest?.url).toBe(
      `https://api.ebay.com/commerce/notification/v1/public_key/${TEST_KEY_ID}`,
    );
  });

  it('serves repeat lookups from cache instead of calling eBay again', async () => {
    const { provider } = harness([KEY_BODY]);

    await provider.getPublicKey(TEST_KEY_ID);
    await provider.getPublicKey(TEST_KEY_ID);
    await provider.getPublicKey(TEST_KEY_ID);

    expect(provider.fetchCount).toBe(1);
  });

  it('collapses concurrent misses onto a single fetch', async () => {
    const { provider } = harness([KEY_BODY]);

    await Promise.all([
      provider.getPublicKey(TEST_KEY_ID),
      provider.getPublicKey(TEST_KEY_ID),
      provider.getPublicKey(TEST_KEY_ID),
    ]);

    expect(provider.fetchCount).toBe(1);
  });

  it('refetches once the cache entry expires', async () => {
    const { provider, advance } = harness([KEY_BODY]);

    await provider.getPublicKey(TEST_KEY_ID);
    advance(DEFAULT_PUBLIC_KEY_TTL_MS - 1);
    await provider.getPublicKey(TEST_KEY_ID);
    expect(provider.fetchCount).toBe(1);

    advance(2);
    await provider.getPublicKey(TEST_KEY_ID);
    expect(provider.fetchCount).toBe(2);
  });

  it('bounds the cache so unknown key ids cannot grow it without limit', async () => {
    const fake = createFakeFetch([tokenResponse(), KEY_BODY]);
    const provider = new NotificationApiPublicKeyProvider({
      apiBaseUrl: 'https://api.ebay.com',
      tokens: new EbayTokenProvider({
        tokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        scopes: ['scope'],
        refreshSkewMs: 0,
        timeoutMs: 1_000,
        fetchImpl: fake.fetchImpl,
      }),
      timeoutMs: 1_000,
      fetchImpl: fake.fetchImpl,
      maxEntries: 2,
    });

    await provider.getPublicKey('key-a');
    await provider.getPublicKey('key-b');
    await provider.getPublicKey('key-c');
    // key-a was evicted, so asking for it again costs another fetch.
    await provider.getPublicKey('key-a');

    expect(provider.fetchCount).toBe(4);
  });

  it('maps an eBay failure onto the connector error taxonomy', async () => {
    const { provider } = harness([{ status: 500, body: ebayErrorBody(500_000, 'internal error') }]);

    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 502,
    );
  });

  it('maps a transport failure onto a retryable upstream error', async () => {
    const { provider } = harness([{ error: new Error('socket hang up') }]);

    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.retryable && error.status === 502,
    );
  });

  it('rejects a response without usable key material', async () => {
    const { provider } = harness([{ status: 200, body: { algorithm: 'ECDSA' } }]);

    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.status === 502,
    );
  });

  it('rejects a key id that is not an opaque identifier without making a request', async () => {
    const { provider } = harness([KEY_BODY]);

    await expect(provider.getPublicKey('../../secrets')).rejects.toThrow();
    expect(provider.fetchCount).toBe(0);
  });

  it('remembers a failed lookup briefly so a replayed key id cannot be amplified', async () => {
    const { provider, advance } = harness([{ status: 503, body: {} }, KEY_BODY]);

    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toThrow();
    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toThrow();
    await expect(provider.getPublicKey(TEST_KEY_ID)).rejects.toThrow();
    expect(provider.fetchCount).toBe(1);

    advance(DEFAULT_PUBLIC_KEY_FAILURE_TTL_MS + 1);
    await expect(provider.getPublicKey(TEST_KEY_ID)).resolves.toMatchObject({ algorithm: 'ECDSA' });
    expect(provider.fetchCount).toBe(2);
  });

  it('caps outbound lookups per window regardless of how many distinct key ids arrive', async () => {
    const { provider } = harness([KEY_BODY], { maxFetchesPerWindow: 3 });

    for (let index = 0; index < 3; index += 1) {
      await provider.getPublicKey(`key-${index}`);
    }
    await expect(provider.getPublicKey('key-overflow')).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.retryable && error.status === 502,
    );

    expect(provider.fetchCount).toBe(3);
  });

  it('does not cache a budget rejection, so the next window recovers', async () => {
    const { provider, advance } = harness([KEY_BODY], { maxFetchesPerWindow: 1 });

    await provider.getPublicKey('key-a');
    await expect(provider.getPublicKey('key-b')).rejects.toThrow();

    advance(DEFAULT_PUBLIC_KEY_FETCH_WINDOW_MS + 1);
    await expect(provider.getPublicKey('key-b')).resolves.toMatchObject({ algorithm: 'ECDSA' });
    expect(provider.fetchCount).toBe(2);
  });

  it('still serves a cached key when the outbound budget is exhausted', async () => {
    const { provider } = harness([KEY_BODY], { maxFetchesPerWindow: 1 });

    await provider.getPublicKey(TEST_KEY_ID);
    await expect(provider.getPublicKey('another-key')).rejects.toThrow();
    // A genuine notification signed with the already known key is unaffected by the flood.
    await expect(provider.getPublicKey(TEST_KEY_ID)).resolves.toMatchObject({ algorithm: 'ECDSA' });
  });

  it('never puts the access token into an error', async () => {
    const { provider } = harness([{ status: 404, body: ebayErrorBody(1_000, 'not found') }]);

    try {
      await provider.getPublicKey(TEST_KEY_ID);
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('token-1');
    }
  });
});
