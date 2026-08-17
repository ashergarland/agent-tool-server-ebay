import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertValidChallengeCode,
  computeChallengeResponse,
} from '../../../src/compliance/ebay-account-deletion/challenge.js';
import { isAppError } from '../../../src/errors.js';

const CHALLENGE_CODE = 'challenge-code-abc123';
/**
 * Obviously synthetic. Test fixtures deliberately avoid high-entropy random-looking strings, so
 * that a secret scanner reports a genuine leaked credential instead of being taught to ignore
 * this file.
 */
const VERIFICATION_TOKEN = 'example-verification-token-not-a-secret-01';
const ENDPOINT_URL =
  'https://connector.example.com/ebay/notifications/marketplace-account-deletion';

/**
 * Independently computed with `sha256(challengeCode + verificationToken + endpoint)`. If this
 * value ever changes, eBay's endpoint registration breaks, so the vector is pinned literally
 * rather than recomputed by the assertion.
 */
const EXPECTED = 'b9e3c4c341c20b5763d5b912b2c75a0ace02ba58aebc635e59bd42c2cf2cd882';

describe('eBay endpoint validation challenge', () => {
  it('matches the documented SHA-256 test vector', () => {
    expect(
      computeChallengeResponse({
        challengeCode: CHALLENGE_CODE,
        verificationToken: VERIFICATION_TOKEN,
        endpointUrl: ENDPOINT_URL,
      }),
    ).toBe(EXPECTED);
  });

  it('hashes exactly challengeCode + verificationToken + endpoint', () => {
    const concatenated = createHash('sha256')
      .update(CHALLENGE_CODE + VERIFICATION_TOKEN + ENDPOINT_URL, 'utf8')
      .digest('hex');
    expect(EXPECTED).toBe(concatenated);
  });

  it('produces a lowercase hexadecimal digest', () => {
    expect(EXPECTED).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is sensitive to the order of the three inputs', () => {
    const swapped = createHash('sha256')
      .update(VERIFICATION_TOKEN + CHALLENGE_CODE + ENDPOINT_URL, 'utf8')
      .digest('hex');
    expect(swapped).not.toBe(EXPECTED);
  });

  it('is sensitive to a trailing slash on the endpoint', () => {
    expect(
      computeChallengeResponse({
        challengeCode: CHALLENGE_CODE,
        verificationToken: VERIFICATION_TOKEN,
        endpointUrl: `${ENDPOINT_URL}/`,
      }),
    ).not.toBe(EXPECTED);
  });

  describe('challenge code validation', () => {
    it('accepts a normal challenge code', () => {
      expect(assertValidChallengeCode(CHALLENGE_CODE)).toBe(CHALLENGE_CODE);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['an array', ['a', 'b']],
      ['a number', 42],
    ])('rejects %s input with a bounded 400', (_label, value) => {
      try {
        assertValidChallengeCode(value);
        expect.unreachable('expected a rejection');
      } catch (error) {
        expect(isAppError(error) && error.status).toBe(400);
      }
    });

    it('rejects an oversized challenge code', () => {
      try {
        assertValidChallengeCode('x'.repeat(513));
        expect.unreachable('expected a rejection');
      } catch (error) {
        expect(isAppError(error) && error.status).toBe(400);
      }
    });

    it('never mentions the verification token when rejecting input', () => {
      try {
        assertValidChallengeCode(undefined);
        expect.unreachable('expected a rejection');
      } catch (error) {
        expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(
          VERIFICATION_TOKEN,
        );
      }
    });
  });
});
