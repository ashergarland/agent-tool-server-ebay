import { createVerify } from 'node:crypto';
import { AppError, badRequest } from '../../errors.js';
import type { PublicKeyProvider } from './public-keys.js';

/**
 * Verification of the `x-ebay-signature` header on an inbound eBay notification.
 *
 * ## Why this is implemented here rather than through `event-notification-nodejs-sdk`
 *
 * eBay's official Node SDK was evaluated first. It is CommonJS-only with no type declarations, its
 * last release is 1.0.3 (June 2023), and it pulls in `axios@^0.21`, `express@^4` and
 * `lru-cache@^6` as *production* dependencies — a large, partly unmaintained transitive footprint
 * for roughly fifty lines of logic. It also writes the closed account's `userId` and `username` to
 * `console.log` from its bundled processor, which directly conflicts with this service's
 * requirement never to log eBay account identifiers, and it offers no injectable logger to stop
 * that. Its cache has no TTL, so it also diverges from eBay's own one-hour caching guidance.
 *
 * This module therefore re-implements exactly the protocol the SDK implements, verified field by
 * field against `eBay/event-notification-nodejs-sdk`'s `lib/validator.js` and the Notification API
 * documentation:
 *
 *   1. base64-decode `x-ebay-signature` into `{ alg, kid, signature, digest }`;
 *   2. fetch the public key named by `kid` from the Notification API (cached);
 *   3. verify the base64 `signature` over the notification payload with ECDSA + the named digest.
 *
 * https://developer.ebay.com/api-docs/commerce/notification/overview.html
 */

export interface EbaySignatureHeader {
  readonly alg: string;
  readonly kid: string;
  readonly signature: string;
  readonly digest: string;
}

export interface SignatureVerificationInput {
  /** The exact bytes received on the wire. */
  readonly rawBody: Buffer;
  /** The same payload after JSON parsing. */
  readonly parsedBody: unknown;
  readonly signatureHeader: string | undefined;
}

export interface SignatureVerifier {
  verify(input: SignatureVerificationInput): Promise<void>;
}

/** Bounds the work done on an unauthenticated request. Real headers are a few hundred bytes. */
const MAX_SIGNATURE_HEADER_LENGTH = 4096;

/**
 * Digests eBay is documented to use. Mapping through an allow-list means a hostile header cannot
 * select an arbitrary or degenerate OpenSSL algorithm name.
 */
const SUPPORTED_DIGESTS: Readonly<Record<string, string>> = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA384: 'sha384',
  SHA512: 'sha512',
};

const SUPPORTED_ALGORITHMS = new Set(['ECDSA']);

/**
 * Case-insensitive comparison of a signature-header field against the corresponding field of the
 * key metadata eBay returned.
 *
 * Case really does differ in practice: eBay's own published fixture carries `"alg":"ecdsa"` in the
 * header while `getPublicKey` reports `"algorithm":"ECDSA"`, so a case-sensitive check would
 * reject a signature eBay genuinely produced.
 *
 * Absent metadata is tolerated. eBay documents `algorithm` and `digest` with occurrence "Always",
 * so absence would be a contract violation rather than a normal case; failing closed on it would
 * add brittleness without adding protection, because the cryptographic verification against the
 * fetched key remains the actual gate.
 */
const metadataAgrees = (headerValue: string, metadataValue: string | undefined): boolean =>
  metadataValue === undefined ||
  metadataValue.length === 0 ||
  metadataValue.toUpperCase() === headerValue.toUpperCase();

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----';
const PEM_FOOTER = '-----END PUBLIC KEY-----';

/**
 * eBay returns the key with the PEM markers already attached but without the line breaks OpenSSL
 * requires, so the body is extracted and re-wrapped at 64 characters. Doing it this way is
 * tolerant of both the marker-less and the already-formatted variants.
 */
export const toPem = (key: string): string => {
  const body = key.replace(PEM_HEADER, '').replace(PEM_FOOTER, '').replace(/\s+/g, '').trim();
  if (body.length === 0 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
    throw new AppError('upstream_error', 'eBay returned an unusable notification public key', {
      retryable: false,
    });
  }
  const wrapped = body.match(/.{1,64}/g)?.join('\n') ?? body;
  return `${PEM_HEADER}\n${wrapped}\n${PEM_FOOTER}\n`;
};

const signatureRejected = (reason: string): AppError =>
  // eBay's documented response to a signature it cannot be shown to have produced.
  new AppError('precondition_failed', `Notification signature verification failed: ${reason}`, {
    retryable: false,
  });

/**
 * Decodes the base64-packed JSON header. Anything malformed is a client error rather than a
 * verification failure, so it never reaches the key-fetch path.
 */
export const parseSignatureHeader = (raw: string | undefined): EbaySignatureHeader => {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw badRequest('An x-ebay-signature header is required.');
  }
  if (raw.length > MAX_SIGNATURE_HEADER_LENGTH) {
    throw badRequest('The x-ebay-signature header is too long.');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw badRequest('The x-ebay-signature header is not base64-encoded JSON.');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    throw badRequest('The x-ebay-signature header did not decode to an object.');
  }

  const { alg, kid, signature, digest } = decoded as Record<string, unknown>;
  if (
    typeof alg !== 'string' ||
    typeof kid !== 'string' ||
    typeof signature !== 'string' ||
    typeof digest !== 'string' ||
    signature.length === 0 ||
    kid.length === 0
  ) {
    throw badRequest('The x-ebay-signature header is missing alg, kid, signature or digest.');
  }

  return { alg, kid, signature, digest };
};

export interface EbaySignatureVerifierOptions {
  readonly publicKeys: PublicKeyProvider;
}

export class EbaySignatureVerifier implements SignatureVerifier {
  public constructor(private readonly options: EbaySignatureVerifierOptions) {}

  public async verify(input: SignatureVerificationInput): Promise<void> {
    const header = parseSignatureHeader(input.signatureHeader);

    if (!SUPPORTED_ALGORITHMS.has(header.alg.toUpperCase())) {
      throw signatureRejected('unsupported signing algorithm');
    }
    const digestAlgorithm = SUPPORTED_DIGESTS[header.digest.toUpperCase()];
    if (digestAlgorithm === undefined) {
      throw signatureRejected('unsupported digest algorithm');
    }

    const publicKey = await this.options.publicKeys.getPublicKey(header.kid);

    /**
     * The signature header is attacker-supplied; the key metadata comes from eBay over an
     * authenticated call. Where they disagree, the header is lying about how the signature was
     * produced, so the notification is rejected before any cryptography is attempted.
     */
    if (!metadataAgrees(header.alg, publicKey.algorithm)) {
      throw signatureRejected('the signing algorithm does not match the signing key');
    }
    if (!metadataAgrees(header.digest, publicKey.digest)) {
      throw signatureRejected('the digest algorithm does not match the signing key');
    }

    const pem = toPem(publicKey.key);

    /**
     * eBay signs the notification payload it transmitted. The received bytes are therefore the
     * authoritative representation and are checked first.
     *
     * The official SDK instead verifies `JSON.stringify(parsedBody)`, which happens to be
     * byte-identical for eBay's compact output. That form is accepted as a fallback so this
     * implementation is never *stricter* than eBay's own reference client — an attacker still
     * needs eBay's private key to satisfy either representation, so accepting both costs nothing.
     */
    const candidates: readonly (Buffer | string)[] = [
      input.rawBody,
      JSON.stringify(input.parsedBody),
    ];

    for (const candidate of candidates) {
      if (this.verifyAgainst(pem, digestAlgorithm, header.signature, candidate)) return;
    }

    throw signatureRejected('the payload does not match the supplied signature');
  }

  private verifyAgainst(
    pem: string,
    digestAlgorithm: string,
    signature: string,
    payload: Buffer | string,
  ): boolean {
    try {
      const verifier = createVerify(digestAlgorithm);
      verifier.update(payload);
      verifier.end();
      return verifier.verify(pem, signature, 'base64');
    } catch {
      // A malformed signature or key makes OpenSSL throw. That is a verification failure, not a
      // connector fault, and the underlying message is never surfaced.
      return false;
    }
  }
}
