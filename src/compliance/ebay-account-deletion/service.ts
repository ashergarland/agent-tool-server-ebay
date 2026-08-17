import type { AppConfig, EbayAccountDeletionConfig } from '../../config/index.js';
import { AppError } from '../../errors.js';
import { EbayTokenProvider, type FetchLike } from '../../provider/ebay/oauth.js';
import {
  assertValidChallengeCode,
  computeChallengeResponse,
  type ChallengeInput,
} from './challenge.js';
import { NotificationApiPublicKeyProvider, type PublicKeyProvider } from './public-keys.js';
import { parseAccountDeletionNotification, ACCOUNT_DELETION_TOPIC } from './schema.js';
import { EbaySignatureVerifier, type SignatureVerifier } from './signature.js';

/**
 * Application service for eBay Marketplace Account Deletion/Closure compliance.
 *
 * It owns the two behaviours eBay requires of a registered callback: answering the
 * endpoint-validation challenge, and authenticating then actioning a deletion notification. HTTP
 * concerns stay in `routes.ts`; everything here is transport-agnostic and unit-testable.
 */

export interface ChallengeResult {
  readonly challengeResponse: string;
}

/**
 * The only logging capability this service needs. Structural rather than a concrete `pino.Logger`
 * so the domain does not depend on the transport's logger implementation.
 */
export interface ComplianceLogger {
  info(payload: Record<string, unknown>, message: string): void;
}

export interface NotificationInput {
  readonly rawBody: Buffer;
  readonly parsedBody: unknown;
  readonly signatureHeader: string | undefined;
  readonly logger: ComplianceLogger;
}

export interface AccountDeletionServiceOptions {
  readonly config: EbayAccountDeletionConfig;
  readonly verifier: SignatureVerifier;
}

export class AccountDeletionService {
  public constructor(private readonly options: AccountDeletionServiceOptions) {}

  /**
   * Answers `GET <endpoint>?challenge_code=...`.
   *
   * The verification token is only ever consumed as hash input; it is never returned, logged or
   * included in an error, so an invalid challenge cannot be used to probe for it.
   */
  public handleChallenge(challengeCode: unknown): ChallengeResult {
    const input: ChallengeInput = {
      challengeCode: assertValidChallengeCode(challengeCode),
      verificationToken: this.options.config.verificationToken,
      endpointUrl: this.options.config.endpointUrl,
    };
    return { challengeResponse: computeChallengeResponse(input) };
  }

  /**
   * Authenticates and actions a deletion notification.
   *
   * Order matters: the signature is verified *before* the payload is interpreted, so an
   * unauthenticated body never reaches the deletion path.
   */
  public async handleNotification(input: NotificationInput): Promise<void> {
    const startedAtMs = Date.now();

    await this.options.verifier.verify({
      rawBody: input.rawBody,
      parsedBody: input.parsedBody,
      signatureHeader: input.signatureHeader,
    });

    const notification = parseAccountDeletionNotification(input.parsedBody);

    this.deleteStoredUserData();

    /**
     * Operational logging only.
     *
     * `notificationId` is an eBay-generated delivery identifier that carries no account data; it
     * is recorded because it is the only value eBay support can correlate a redelivery against.
     * `username`, `userId` and `eiasToken` are deliberately absent, as is the payload itself.
     */
    input.logger.info(
      {
        event: 'ebay.account_deletion.processed',
        topic: ACCOUNT_DELETION_TOPIC,
        notificationId: notification.notification.notificationId,
        publishAttemptCount: notification.notification.publishAttemptCount,
        durationMs: Date.now() - startedAtMs,
        outcome: 'acknowledged',
      },
      'eBay marketplace account deletion notification acknowledged',
    );
  }

  /**
   * Erases every trace of the identified eBay account from this service.
   *
   * This is intentionally a no-op, and that is a statement about the system rather than an
   * omission. The connector is strictly read-only and stateless with respect to eBay data:
   *
   *  - listing responses are not cached or written to disk;
   *  - no eBay user profile, buyer or seller record is stored;
   *  - notification payloads are not persisted;
   *  - account identifiers are never written to logs or telemetry.
   *
   * There is therefore nothing to delete, and re-delivery of the same notification is inherently
   * idempotent.
   *
   * **If any persistent store of eBay user data is ever added — a cache keyed by seller, a saved
   * search, an analytics sink — this method MUST delete from it irreversibly before that feature
   * can ship to production.**
   */
  private deleteStoredUserData(): void {
    // Intentionally empty. See the contract above before changing this.
  }
}

export interface CreateAccountDeletionServiceOptions {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  /** Injectable for tests; defaults to the real Notification API-backed provider. */
  readonly publicKeys?: PublicKeyProvider;
  readonly verifier?: SignatureVerifier;
}

/**
 * Builds the service from application configuration, reusing the existing eBay client-credentials
 * OAuth machinery for the Notification API call that fetches signing keys.
 *
 * Returns `undefined` when the deployment has not been given both a callback URL and a
 * verification token: a partially configured endpoint would answer eBay's challenge with the
 * wrong hash, which is worse than not answering at all.
 */
export const createAccountDeletionService = (
  config: AppConfig,
  options: CreateAccountDeletionServiceOptions = {},
): AccountDeletionService | undefined => {
  const accountDeletion = config.ebay.accountDeletion;
  if (!accountDeletion) return undefined;

  if (options.verifier) {
    return new AccountDeletionService({ config: accountDeletion, verifier: options.verifier });
  }

  const publicKeys = options.publicKeys ?? createPublicKeyProvider(config, options);
  return new AccountDeletionService({
    config: accountDeletion,
    verifier: new EbaySignatureVerifier({ publicKeys }),
  });
};

/**
 * The signing-key lookup is lazy: it needs eBay application credentials, and a deployment is
 * allowed to expose the challenge endpoint before those are in place. Building it eagerly would
 * turn a missing credential into a startup crash rather than a bounded upstream error on the
 * first notification.
 */
const createPublicKeyProvider = (
  config: AppConfig,
  options: CreateAccountDeletionServiceOptions,
): PublicKeyProvider => {
  let instance: NotificationApiPublicKeyProvider | undefined;

  const resolve = (): NotificationApiPublicKeyProvider => {
    if (instance) return instance;
    const { clientId, clientSecret } = config.ebay;
    if (!clientId || !clientSecret) {
      throw new AppError(
        'upstream_error',
        'eBay application credentials are not configured, so notification signatures cannot be verified.',
        { retryable: false },
      );
    }
    instance = new NotificationApiPublicKeyProvider({
      apiBaseUrl: config.ebay.apiBaseUrl,
      tokens: new EbayTokenProvider({
        tokenUrl: config.ebay.oauthTokenUrl,
        clientId,
        clientSecret,
        scopes: config.ebay.scopes,
        refreshSkewMs: config.ebay.tokenRefreshSkewMs,
        timeoutMs: config.ebay.requestTimeoutMs,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.now ? { now: options.now } : {}),
      }),
      timeoutMs: config.ebay.requestTimeoutMs,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    return instance;
  };

  return { getPublicKey: (keyId) => resolve().getPublicKey(keyId) };
};
