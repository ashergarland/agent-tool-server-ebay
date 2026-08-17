import { createHash } from 'node:crypto';
import { badRequest } from '../../errors.js';

/**
 * eBay's endpoint-validation challenge.
 *
 * When a callback URL is saved in the developer portal — and periodically afterwards — eBay issues
 * `GET <endpoint>?challenge_code=<value>` and expects the SHA-256 hash of exactly
 * `challengeCode + verificationToken + endpoint`, in that order, as lowercase hexadecimal.
 *
 * https://developer.ebay.com/develop/guides-v2/marketplace-user-account-deletion
 */

/**
 * eBay's challenge codes are opaque; this bound only exists so a caller cannot force unbounded
 * hashing work through the public route.
 */
const MAX_CHALLENGE_CODE_LENGTH = 512;

/**
 * Rejects anything that is not a plausible challenge code before it reaches the hash. The error
 * deliberately describes only the *input*, never the configured verification token.
 */
export const assertValidChallengeCode = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest('A challenge_code query parameter is required.');
  }
  if (value.length > MAX_CHALLENGE_CODE_LENGTH) {
    throw badRequest('The challenge_code query parameter is too long.');
  }
  return value;
};

export interface ChallengeInput {
  readonly challengeCode: string;
  readonly verificationToken: string;
  /** The externally advertised callback URL, byte-for-byte as registered with eBay. */
  readonly endpointUrl: string;
}

/**
 * Returns the lowercase hex SHA-256 digest eBay expects.
 *
 * The three values are hashed as separate UTF-8 updates in the documented order. Changing the
 * order, the encoding or the endpoint string (including a trailing slash) produces a different
 * digest and eBay refuses to register the endpoint.
 */
export const computeChallengeResponse = (input: ChallengeInput): string => {
  const hash = createHash('sha256');
  hash.update(input.challengeCode, 'utf8');
  hash.update(input.verificationToken, 'utf8');
  hash.update(input.endpointUrl, 'utf8');
  return hash.digest('hex');
};
