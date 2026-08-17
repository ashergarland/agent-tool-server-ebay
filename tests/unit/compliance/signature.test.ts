import { describe, expect, it } from 'vitest';
import {
  EbaySignatureVerifier,
  parseSignatureHeader,
  toPem,
} from '../../../src/compliance/ebay-account-deletion/signature.js';
import type { PublicKeyProvider } from '../../../src/compliance/ebay-account-deletion/public-keys.js';
import { AppError, isAppError } from '../../../src/errors.js';
import {
  buildSignatureHeader,
  FakePublicKeyProvider,
  signPayload,
  signedNotification,
  testPublicKeyPem,
  testPublicKeyAsEbayReturnsIt,
  validNotificationBody,
} from '../../helpers/ebay-signature.js';

const statusOf = async (run: () => Promise<unknown>): Promise<number> => {
  try {
    await run();
  } catch (error) {
    if (isAppError(error)) return error.status;
    throw error;
  }
  throw new Error('expected a rejection');
};

describe('x-ebay-signature header parsing', () => {
  it('decodes the base64-packed JSON header', () => {
    const header = buildSignatureHeader({ signature: 'c2ln' });
    expect(parseSignatureHeader(header)).toEqual({
      alg: 'ECDSA',
      kid: 'test-key-id-0001',
      digest: 'SHA1',
      signature: 'c2ln',
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not base64 JSON', 'bm90LWpzb24='],
    ['a JSON scalar', Buffer.from('"a string"', 'utf8').toString('base64')],
    ['missing kid', Buffer.from(JSON.stringify({ alg: 'ECDSA' }), 'utf8').toString('base64')],
  ])('rejects a %s header with 400', (_label, header) => {
    try {
      parseSignatureHeader(header);
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(isAppError(error) && error.status).toBe(400);
    }
  });

  it('rejects an oversized header without decoding it', () => {
    try {
      parseSignatureHeader('A'.repeat(5000));
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(isAppError(error) && error.status).toBe(400);
    }
  });
});

describe('public key PEM normalisation', () => {
  it('restores line breaks on the marker-less key eBay returns', () => {
    expect(toPem(testPublicKeyAsEbayReturnsIt)).toBe(`${testPublicKeyPem}\n`);
  });

  it('is idempotent for an already formatted key', () => {
    expect(toPem(testPublicKeyPem)).toBe(toPem(testPublicKeyAsEbayReturnsIt));
  });

  it('rejects key material that is not base64', () => {
    expect(() => toPem('-----BEGIN PUBLIC KEY-----not a key!-----END PUBLIC KEY-----')).toThrow(
      AppError,
    );
  });
});

describe('EbaySignatureVerifier', () => {
  const verifierFor = (publicKeys: PublicKeyProvider): EbaySignatureVerifier =>
    new EbaySignatureVerifier({ publicKeys });

  it('accepts a correctly signed notification', async () => {
    const body = validNotificationBody();
    const { raw, header } = signedNotification(body);

    await expect(
      verifierFor(new FakePublicKeyProvider()).verify({
        rawBody: raw,
        parsedBody: body,
        signatureHeader: header,
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a signature computed over the re-serialised body, as eBay\u2019s own SDK does', async () => {
    const body = validNotificationBody();
    const canonical = JSON.stringify(body);
    // The bytes on the wire are formatted differently from the canonical serialisation.
    const raw = Buffer.from(JSON.stringify(body, null, 2), 'utf8');

    await expect(
      verifierFor(new FakePublicKeyProvider()).verify({
        rawBody: raw,
        parsedBody: body,
        signatureHeader: buildSignatureHeader({ signature: signPayload(canonical) }),
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects a signature produced over a different payload with 412', async () => {
    const body = validNotificationBody();
    const header = buildSignatureHeader({
      signature: signPayload(Buffer.from(JSON.stringify({ tampered: true }), 'utf8')),
    });

    expect(
      await statusOf(() =>
        verifierFor(new FakePublicKeyProvider()).verify({
          rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
          parsedBody: body,
          signatureHeader: header,
        }),
      ),
    ).toBe(412);
  });

  it('rejects a structurally invalid signature value with 412', async () => {
    const body = validNotificationBody();
    expect(
      await statusOf(() =>
        verifierFor(new FakePublicKeyProvider()).verify({
          rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
          parsedBody: body,
          signatureHeader: buildSignatureHeader({ signature: 'bm90LWEtc2lnbmF0dXJl' }),
        }),
      ),
    ).toBe(412);
  });

  it('rejects a missing x-ebay-signature header with 400', async () => {
    const body = validNotificationBody();
    expect(
      await statusOf(() =>
        verifierFor(new FakePublicKeyProvider()).verify({
          rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
          parsedBody: body,
          signatureHeader: undefined,
        }),
      ),
    ).toBe(400);
  });

  it('rejects an unsupported signing algorithm before fetching a key', async () => {
    const keys = new FakePublicKeyProvider();
    const body = validNotificationBody();
    const { raw } = signedNotification(body);

    expect(
      await statusOf(() =>
        verifierFor(keys).verify({
          rawBody: raw,
          parsedBody: body,
          signatureHeader: buildSignatureHeader({ alg: 'HMAC', signature: signPayload(raw) }),
        }),
      ),
    ).toBe(412);
    expect(keys.calls).toBe(0);
  });

  it('rejects an unsupported digest before fetching a key', async () => {
    const keys = new FakePublicKeyProvider();
    const body = validNotificationBody();
    const { raw } = signedNotification(body);

    expect(
      await statusOf(() =>
        verifierFor(keys).verify({
          rawBody: raw,
          parsedBody: body,
          signatureHeader: buildSignatureHeader({ digest: 'MD5', signature: signPayload(raw) }),
        }),
      ),
    ).toBe(412);
    expect(keys.calls).toBe(0);
  });

  it('maps a public-key fetch failure onto a bounded upstream error', async () => {
    const failing: PublicKeyProvider = {
      getPublicKey: () =>
        Promise.reject(new AppError('upstream_error', 'eBay is unavailable', { retryable: true })),
    };
    const body = validNotificationBody();
    const { raw, header } = signedNotification(body);

    expect(
      await statusOf(() =>
        verifierFor(failing).verify({ rawBody: raw, parsedBody: body, signatureHeader: header }),
      ),
    ).toBe(502);
  });

  it('never leaks the signature, the key or account identifiers in a failure', async () => {
    const body = validNotificationBody();
    const header = buildSignatureHeader({ signature: signPayload('other') });

    try {
      await verifierFor(new FakePublicKeyProvider()).verify({
        rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
        parsedBody: body,
        signatureHeader: header,
      });
      expect.unreachable('expected a rejection');
    } catch (error) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).not.toContain(header);
      expect(serialised).not.toContain('example_user');
      expect(serialised).not.toContain('example-user-id');
      expect(serialised).not.toContain('BEGIN PUBLIC KEY');
    }
  });
});
