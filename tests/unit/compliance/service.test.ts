import { describe, expect, it } from 'vitest';
import { createAccountDeletionService } from '../../../src/compliance/ebay-account-deletion/service.js';
import { isAppError } from '../../../src/errors.js';
import { testConfig } from '../../helpers/config.js';
import {
  buildSignatureHeader,
  FakePublicKeyProvider,
  signPayload,
  validNotificationBody,
} from '../../helpers/ebay-signature.js';
import { createFakeFetch, tokenResponse } from '../../helpers/fake-fetch.js';
import { testPublicKeyAsEbayReturnsIt } from '../../helpers/ebay-signature.js';

const ENDPOINT = 'https://connector.example.com/ebay/notifications/marketplace-account-deletion';
const TOKEN = 'example-compliance-verification-token-0001';

const complianceConfig = (overrides: Record<string, string | undefined> = {}) =>
  testConfig({
    EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT,
    EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
    ...overrides,
  });

/** Captures what the service asks to be logged so the privacy contract can be asserted. */
const recordingLogger = () => {
  const entries: { payload: Record<string, unknown>; message: string }[] = [];
  return {
    entries,
    logger: {
      info: (payload: Record<string, unknown>, message: string) => {
        entries.push({ payload, message });
      },
    },
  };
};

describe('createAccountDeletionService', () => {
  it('returns nothing when the deployment is not configured for compliance', () => {
    expect(createAccountDeletionService(testConfig())).toBeUndefined();
  });

  it('builds a service when both the endpoint and the token are configured', () => {
    expect(createAccountDeletionService(complianceConfig())).toBeDefined();
  });

  it('answers the challenge using the configured endpoint and token', () => {
    const service = createAccountDeletionService(complianceConfig(), {
      publicKeys: new FakePublicKeyProvider(),
    });

    expect(service?.handleChallenge('abc-123')).toEqual({
      challengeResponse: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('verifies a notification end to end through the real Notification API client', async () => {
    // Only the eBay HTTP calls are faked: the OAuth grant, the public-key lookup, the PEM
    // normalisation and the ECDSA verification all run for real.
    const fake = createFakeFetch([
      tokenResponse(),
      {
        status: 200,
        body: { key: testPublicKeyAsEbayReturnsIt, algorithm: 'ECDSA', digest: 'SHA1' },
      },
    ]);
    const service = createAccountDeletionService(complianceConfig(), {
      fetchImpl: fake.fetchImpl,
    });

    const body = validNotificationBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const { logger, entries } = recordingLogger();

    await service?.handleNotification({
      rawBody: raw,
      parsedBody: body,
      signatureHeader: buildSignatureHeader({ signature: signPayload(raw) }),
      logger,
    });

    expect(fake.requests.map((request) => request.url)).toEqual([
      'https://api.ebay.com/identity/v1/oauth2/token',
      'https://api.ebay.com/commerce/notification/v1/public_key/test-key-id-0001',
    ]);
    expect(entries).toHaveLength(1);
  });

  it('logs only low-sensitivity operational fields', async () => {
    const service = createAccountDeletionService(complianceConfig(), {
      publicKeys: new FakePublicKeyProvider(),
    });
    const body = validNotificationBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const { logger, entries } = recordingLogger();

    await service?.handleNotification({
      rawBody: raw,
      parsedBody: body,
      signatureHeader: buildSignatureHeader({ signature: signPayload(raw) }),
      logger,
    });

    const serialised = JSON.stringify(entries);
    expect(serialised).not.toContain('example_user');
    expect(serialised).not.toContain('example-user-id');
    expect(serialised).not.toContain('eiasToken');
    expect(serialised).not.toContain(TOKEN);
    expect(entries[0]?.payload).toEqual({
      event: 'ebay.account_deletion.processed',
      topic: 'MARKETPLACE_ACCOUNT_DELETION',
      notificationId:
        body['notification'] instanceof Object
          ? (body['notification'] as Record<string, unknown>)['notificationId']
          : undefined,
      publishAttemptCount: 1,
      durationMs: expect.any(Number),
      outcome: 'acknowledged',
    });
  });

  it('does not log anything when the signature fails to verify', async () => {
    const service = createAccountDeletionService(complianceConfig(), {
      publicKeys: new FakePublicKeyProvider(),
    });
    const body = validNotificationBody();
    const { logger, entries } = recordingLogger();

    await expect(
      service?.handleNotification({
        rawBody: Buffer.from(JSON.stringify(body), 'utf8'),
        parsedBody: body,
        signatureHeader: buildSignatureHeader({ signature: signPayload('mismatch') }),
        logger,
      }),
    ).rejects.toThrow();

    expect(entries).toEqual([]);
  });

  it('fails with a bounded upstream error when eBay credentials are absent', async () => {
    const service = createAccountDeletionService(
      complianceConfig({ EBAY_CLIENT_ID: undefined, EBAY_CLIENT_SECRET: undefined }),
    );
    const body = validNotificationBody();
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    const { logger } = recordingLogger();

    // The challenge still works: registering the endpoint must not depend on Browse credentials.
    expect(service?.handleChallenge('abc')).toBeDefined();

    try {
      await service?.handleNotification({
        rawBody: raw,
        parsedBody: body,
        signatureHeader: buildSignatureHeader({ signature: signPayload(raw) }),
        logger,
      });
      expect.unreachable('expected a rejection');
    } catch (error) {
      expect(isAppError(error) && error.status).toBe(502);
      expect(isAppError(error) && error.retryable).toBe(false);
    }
  });
});
