import { describe, expect, it } from 'vitest';
import { EbaySignatureVerifier } from '../../../src/compliance/ebay-account-deletion/signature.js';
import { parseAccountDeletionNotification } from '../../../src/compliance/ebay-account-deletion/schema.js';
import type {
  EbayPublicKey,
  PublicKeyProvider,
} from '../../../src/compliance/ebay-account-deletion/public-keys.js';
import { isAppError } from '../../../src/errors.js';
import fixture from '../../fixtures/ebay-published-notification.json' with { type: 'json' };

/**
 * Interoperability with a signature eBay actually produced.
 *
 * The rest of the signature suite generates its own P-256 key pair. That proves the implementation
 * is self-consistent, but a self-consistent implementation of the *wrong* protocol would pass just
 * as happily. This test closes that gap using eBay's own published test vector from the official
 * `event-notification-nodejs-sdk` — see `tests/fixtures/ebay-published-notification.json` for the
 * source URL and the upstream blob SHA. It is public sample data: eBay-fabricated account
 * identifiers, a public verification key, and a signature over that public payload.
 *
 * No network call and no credentials: the fixture is committed and the key is injected.
 */

const publicKeyProvider = (overrides: Partial<EbayPublicKey> = {}): PublicKeyProvider => ({
  getPublicKey: () =>
    Promise.resolve({
      key: fixture.publicKey,
      algorithm: fixture.algorithm,
      digest: fixture.digest,
      ...overrides,
    }),
});

/** Exactly the bytes eBay signed. */
const signedBytes = Buffer.from(fixture.signedPayload, 'utf8');

const verifyFixture = (provider: PublicKeyProvider): Promise<void> =>
  new EbaySignatureVerifier({ publicKeys: provider }).verify({
    rawBody: signedBytes,
    parsedBody: JSON.parse(fixture.signedPayload) as unknown,
    signatureHeader: fixture.signatureHeader,
  });

const rejectionStatus = async (run: () => Promise<unknown>): Promise<number> => {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.status;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe("eBay's published signature fixture", () => {
  it('verifies a signature produced by eBay, not by our own test helpers', async () => {
    await expect(verifyFixture(publicKeyProvider())).resolves.toBeUndefined();
  });

  it('carries the protocol shape this implementation expects', () => {
    const header = JSON.parse(
      Buffer.from(fixture.signatureHeader, 'base64').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(header).sort()).toEqual(['alg', 'digest', 'kid', 'signature']);
    expect(header['kid']).toBe(fixture.keyId);
    // The published header really is lower-case while getPublicKey reports "ECDSA". A
    // case-sensitive comparison anywhere in this path would reject a genuine eBay signature.
    expect(header['alg']).toBe('ecdsa');
    expect(fixture.algorithm).toBe('ECDSA');
    expect(header['digest']).toBe('SHA1');
  });

  it('is a payload our schema validation accepts', () => {
    const parsed = parseAccountDeletionNotification(JSON.parse(fixture.signedPayload));
    expect(parsed.metadata.topic).toBe('MARKETPLACE_ACCOUNT_DELETION');
    expect(parsed.notification.publishAttemptCount).toBe(1);
  });

  it('verifies when only the parsed body is available, as eBay\u2019s own SDK does', async () => {
    // eBay's SDK signs `JSON.stringify(message)`; proving the fallback path against the published
    // vector confirms the two representations really are interchangeable here.
    await expect(
      new EbaySignatureVerifier({ publicKeys: publicKeyProvider() }).verify({
        rawBody: Buffer.from('{}', 'utf8'),
        parsedBody: JSON.parse(fixture.signedPayload) as unknown,
        signatureHeader: fixture.signatureHeader,
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects the published signature once a single payload byte changes', async () => {
    const tampered = JSON.parse(fixture.signedPayload) as {
      notification: { publishAttemptCount: number };
    };
    tampered.notification.publishAttemptCount = 2;

    expect(
      await rejectionStatus(() =>
        new EbaySignatureVerifier({ publicKeys: publicKeyProvider() }).verify({
          rawBody: Buffer.from(JSON.stringify(tampered), 'utf8'),
          parsedBody: tampered,
          signatureHeader: fixture.signatureHeader,
        }),
      ),
    ).toBe(412);
  });

  it('rejects the published signature against a different key', async () => {
    const otherKey =
      '-----BEGIN PUBLIC KEY-----MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEA0M4YsXdK6Xg8MOBup6G+8x7yw8l' +
      'pQlg/tNz8X9UWj3jYH61PLg2rhXARBilbdK/vpaMmvA/+nC42GU5MZCQRw==-----END PUBLIC KEY-----';

    expect(await rejectionStatus(() => verifyFixture(publicKeyProvider({ key: otherKey })))).toBe(
      412,
    );
  });
});
