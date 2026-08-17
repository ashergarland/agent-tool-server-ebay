/**
 * eBay Marketplace Account Deletion/Closure compliance.
 *
 * This directory is deliberately self-contained — configuration in, HTTP route out — so that it
 * can later move behind a shared platform's route-extension mechanism as capability-owned code
 * without touching the rest of the server.
 */
export {
  assertValidChallengeCode,
  computeChallengeResponse,
  type ChallengeInput,
} from './challenge.js';
export {
  DEFAULT_PUBLIC_KEY_CACHE_MAX_ENTRIES,
  DEFAULT_PUBLIC_KEY_FAILURE_TTL_MS,
  DEFAULT_PUBLIC_KEY_FETCH_WINDOW_MS,
  DEFAULT_PUBLIC_KEY_MAX_FETCHES_PER_WINDOW,
  DEFAULT_PUBLIC_KEY_TTL_MS,
  NotificationApiPublicKeyProvider,
  type EbayPublicKey,
  type PublicKeyProvider,
} from './public-keys.js';
export {
  ACCOUNT_DELETION_ROUTE_PATH,
  accountDeletionRoutes,
  type AccountDeletionRoutesOptions,
} from './routes.js';
export {
  ACCOUNT_DELETION_TOPIC,
  accountDeletionNotificationSchema,
  parseAccountDeletionNotification,
  type AccountDeletionNotification,
} from './schema.js';
export {
  AccountDeletionService,
  createAccountDeletionService,
  type ComplianceLogger,
  type CreateAccountDeletionServiceOptions,
  type NotificationInput,
} from './service.js';
export {
  EbaySignatureVerifier,
  parseSignatureHeader,
  toPem,
  type EbaySignatureHeader,
  type SignatureVerificationInput,
  type SignatureVerifier,
} from './signature.js';
