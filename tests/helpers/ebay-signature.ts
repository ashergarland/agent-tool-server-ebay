import { createSign, generateKeyPairSync } from 'node:crypto';
import type {
  EbayPublicKey,
  PublicKeyProvider,
} from '../../src/compliance/ebay-account-deletion/public-keys.js';

/**
 * Hermetic stand-in for eBay's notification signing.
 *
 * eBay signs notifications with ECDSA over a SHA-1 digest and publishes the matching P-256 public
 * key through the Notification API. These helpers reproduce exactly that so the verifier can be
 * exercised without any network access or real credentials.
 */

export const TEST_KEY_ID = 'test-key-id-0001';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** The PEM eBay would return, normalised the way the Notification API presents it. */
export const testPublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();

/**
 * eBay returns the markers concatenated with the base64 body and no line breaks. Reproducing that
 * shape keeps the PEM-normalisation path under test.
 */
export const testPublicKeyAsEbayReturnsIt = testPublicKeyPem.replace(/\n/g, '');

export const signPayload = (payload: string | Buffer, digest = 'sha1'): string => {
  const signer = createSign(digest);
  signer.update(payload);
  signer.end();
  return signer.sign(privateKey, 'base64');
};

export interface SignatureHeaderOptions {
  readonly alg?: string;
  readonly kid?: string;
  readonly digest?: string;
  readonly signature?: string;
}

export const buildSignatureHeader = (options: SignatureHeaderOptions = {}): string =>
  Buffer.from(
    JSON.stringify({
      alg: options.alg ?? 'ECDSA',
      kid: options.kid ?? TEST_KEY_ID,
      digest: options.digest ?? 'SHA1',
      signature: options.signature ?? '',
    }),
    'utf8',
  ).toString('base64');

/** A valid notification body plus the signature header eBay would send with it. */
export const signedNotification = (
  body: Record<string, unknown>,
): { raw: Buffer; header: string } => {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  return { raw, header: buildSignatureHeader({ signature: signPayload(raw) }) };
};

export class FakePublicKeyProvider implements PublicKeyProvider {
  public calls = 0;

  public constructor(
    private readonly key: string = testPublicKeyAsEbayReturnsIt,
    /**
     * The metadata `getPublicKey` reports alongside the key. Overridable so tests can prove the
     * verifier cross-checks it against the signature header.
     */
    private readonly metadata: Partial<Pick<EbayPublicKey, 'algorithm' | 'digest'>> = {},
  ) {}

  public getPublicKey(_keyId: string): Promise<EbayPublicKey> {
    this.calls += 1;
    return Promise.resolve({
      key: this.key,
      algorithm: 'ECDSA',
      digest: 'SHA1',
      ...this.metadata,
    });
  }
}

export const validNotificationBody = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  metadata: {
    topic: 'MARKETPLACE_ACCOUNT_DELETION',
    schemaVersion: '1.0',
    deprecated: false,
  },
  notification: {
    notificationId: '49feeaeb-4982-42d9-a377-9645b8479411_33f7e043-fed8-442b-9d44-791923bd9a6d',
    eventDate: '2021-03-19T20:43:59.462Z',
    publishDate: '2021-03-19T20:43:59.679Z',
    publishAttemptCount: 1,
    /**
     * Structurally what eBay sends, but deliberately readable rather than the opaque
     * high-entropy value from eBay's documentation: fixtures should never look enough like a real
     * credential to train a secret scanner to ignore this file.
     */
    data: {
      username: 'example_user',
      userId: 'example-user-id',
      eiasToken: 'example-eias-token-not-a-real-identifier',
    },
  },
  ...overrides,
});
