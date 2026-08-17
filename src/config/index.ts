import { z } from 'zod';
import { MARKETPLACE_IDS, type MarketplaceId } from '../provider/ebay/marketplaces.js';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const csvList = z
  .string()
  .transform(csv)
  .pipe(z.array(z.string().min(1)))
  .catch([] as string[]);

/**
 * Drops variables whose value is blank so an empty string means "not set" rather than "set to
 * something invalid".
 *
 * Deployment platforms routinely materialise an unset value as an empty string: the Container App
 * template always declares `PUBLIC_BASE_URL`, `EBAY_DELIVERY_COUNTRY` and
 * `EBAY_DELIVERY_POSTAL_CODE`, and the first provisioning pass has no public URL to supply yet.
 * Without this, `z.url()` and the delivery-field validators would reject those empty strings and
 * the container would exit at startup instead of falling back to its defaults.
 */
export const withoutBlankValues = (source: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(([, value]) => value === undefined || value.trim() !== ''),
  );

/**
 * Environment contract for the connector. Everything the process needs is declared here so that
 * a misconfigured deployment fails fast at startup instead of at the first eBay call.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SERVICE_NAME: z.string().min(1).default('agent-tool-server-ebay'),
  SERVICE_VERSION: z.string().min(1).default('0.1.0'),
  GIT_SHA: z.string().default('unknown'),
  PUBLIC_BASE_URL: z.url().optional(),

  REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(120),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),

  // Authentication of the *caller* (ChatGPT). Never reuses the eBay application credentials.
  AUTH_MODE: z.enum(['api-key', 'disabled']).default('api-key'),
  API_KEYS: csvList.default([]),

  // Authentication *to* eBay (OAuth client credentials for the Browse API).
  EBAY_CLIENT_ID: z.string().min(1).optional(),
  EBAY_CLIENT_SECRET: z.string().min(1).optional(),
  EBAY_ENVIRONMENT: z.enum(['production', 'sandbox']).default('production'),
  EBAY_MARKETPLACE_ID: z.enum(MARKETPLACE_IDS).default('EBAY_US'),
  EBAY_OAUTH_SCOPES: csvList.default(['https://api.ebay.com/oauth/api_scope']),
  /** Renew the application token this long before it actually expires. */
  EBAY_TOKEN_REFRESH_SKEW_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  EBAY_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  EBAY_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),

  /**
   * Buyer context sent as `X-EBAY-C-ENDUSERCTX`. eBay only returns `shippingOptions` for
   * listings with calculated shipping when a contextual location is supplied, so a default
   * country/postcode materially improves the delivered-total figures the connector can report.
   */
  EBAY_DELIVERY_COUNTRY: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'must be a two letter ISO 3166 country code')
    .transform((value) => value.toUpperCase())
    .optional(),
  EBAY_DELIVERY_POSTAL_CODE: z.string().min(1).max(20).optional(),
  /** eBay Partner Network campaign id; when set, eBay returns affiliate item URLs. */
  EBAY_AFFILIATE_CAMPAIGN_ID: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),

  /**
   * Marketplace Account Deletion/Closure compliance. Both values must be present before the
   * public callback route is mounted, because eBay's endpoint-validation challenge hashes the
   * verification token together with the *exact* URL registered in the developer portal.
   *
   * The URL is ordinary configuration; the token is a secret and is never surfaced by `/version`,
   * `/tools` or the OpenAPI document.
   */
  EBAY_ACCOUNT_DELETION_ENDPOINT_URL: z.url().optional(),
  /**
   * eBay documents the allowed token as 32–80 characters drawn from alphanumerics, underscore
   * and hyphen. Anything else is rejected by the developer portal, so it is rejected here too
   * rather than failing halfway through registration.
   */
  EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{32,80}$/,
      'must be 32-80 characters using only letters, digits, underscore and hyphen',
    )
    .optional(),

  // Result-size guardrails applied to every search-shaped tool.
  EBAY_SEARCH_DEFAULT_LIMIT: z.coerce.number().int().min(1).max(200).default(20),
  EBAY_SEARCH_MAX_LIMIT: z.coerce.number().int().min(1).max(200).default(50),
  EBAY_COMPARE_MAX_ITEMS: z.coerce.number().int().min(2).max(20).default(8),
});

export type Env = z.infer<typeof envSchema>;

export interface EbayAccountDeletionConfig {
  /**
   * The externally advertised callback URL, byte-for-byte as entered in the eBay developer
   * portal. eBay hashes this exact string, so a trailing slash or a differing host makes the
   * challenge response wrong.
   */
  readonly endpointUrl: string;
  /** Secret shared with eBay. Never logged, never serialised into a response. */
  readonly verificationToken: string;
}

export interface AppConfig {
  readonly env: Env['NODE_ENV'];
  readonly isProduction: boolean;
  readonly service: {
    readonly name: string;
    readonly version: string;
    readonly gitSha: string;
    readonly publicBaseUrl: string | undefined;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
    readonly requestTimeoutMs: number;
    readonly rateLimit: { readonly max: number; readonly windowMs: number };
  };
  readonly logLevel: Env['LOG_LEVEL'];
  readonly auth:
    | { readonly mode: 'disabled' }
    | { readonly mode: 'api-key'; readonly apiKeys: readonly string[] };
  readonly ebay: {
    readonly environment: 'production' | 'sandbox';
    readonly clientId: string | undefined;
    readonly clientSecret: string | undefined;
    readonly configured: boolean;
    readonly apiBaseUrl: string;
    readonly oauthTokenUrl: string;
    readonly scopes: readonly string[];
    readonly defaultMarketplaceId: MarketplaceId;
    readonly tokenRefreshSkewMs: number;
    readonly maxRetries: number;
    readonly retryBaseDelayMs: number;
    readonly requestTimeoutMs: number;
    readonly deliveryCountry: string | undefined;
    readonly deliveryPostalCode: string | undefined;
    readonly affiliateCampaignId: string | undefined;
    /**
     * Present only when both the callback URL and the verification token are configured. When it
     * is undefined the Marketplace Account Deletion route is not mounted at all, so an
     * incompletely configured deployment cannot answer eBay's challenge with a wrong hash.
     */
    readonly accountDeletion: EbayAccountDeletionConfig | undefined;
  };
  readonly limits: {
    readonly searchDefaultLimit: number;
    readonly searchMaxLimit: number;
    readonly compareMaxItems: number;
  };
}

export class ConfigurationError extends Error {
  public override readonly name = 'ConfigurationError';
}

/**
 * Official eBay REST hosts. The OAuth token endpoint and the Browse API share a host per
 * environment; the OAuth *scope* string is `api.ebay.com`-based in both environments.
 */
const EBAY_HOSTS = {
  production: 'https://api.ebay.com',
  sandbox: 'https://api.sandbox.ebay.com',
} as const;

const buildAuthConfig = (env: Env): AppConfig['auth'] => {
  switch (env.AUTH_MODE) {
    case 'disabled':
      if (env.NODE_ENV === 'production') {
        throw new ConfigurationError(
          'AUTH_MODE=disabled is not permitted when NODE_ENV=production',
        );
      }
      return { mode: 'disabled' };
    case 'api-key':
      if (env.API_KEYS.length === 0) {
        throw new ConfigurationError('AUTH_MODE=api-key requires at least one value in API_KEYS');
      }
      if (env.API_KEYS.some((key) => key.length < 32)) {
        throw new ConfigurationError('Every entry in API_KEYS must be at least 32 characters long');
      }
      return { mode: 'api-key', apiKeys: env.API_KEYS };
  }
};

const buildAccountDeletionConfig = (env: Env): EbayAccountDeletionConfig | undefined => {
  const endpointUrl = env.EBAY_ACCOUNT_DELETION_ENDPOINT_URL;
  const verificationToken = env.EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN;

  if (endpointUrl === undefined) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch {
    throw new ConfigurationError('EBAY_ACCOUNT_DELETION_ENDPOINT_URL must be an absolute URL');
  }

  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(
      'EBAY_ACCOUNT_DELETION_ENDPOINT_URL must use https when NODE_ENV=production; eBay only accepts an HTTPS callback',
    );
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ConfigurationError('EBAY_ACCOUNT_DELETION_ENDPOINT_URL must use http or https');
  }
  // eBay hashes the registered URL verbatim, and the portal does not accept a query string or a
  // fragment. Rejecting them here turns a silent challenge mismatch into a startup failure.
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigurationError(
      'EBAY_ACCOUNT_DELETION_ENDPOINT_URL must not contain a query string or fragment',
    );
  }

  if (verificationToken === undefined) {
    throw new ConfigurationError(
      'EBAY_ACCOUNT_DELETION_ENDPOINT_URL requires EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN to be set as well',
    );
  }

  return { endpointUrl, verificationToken };
};

const buildEbayConfig = (env: Env): AppConfig['ebay'] => {
  const hasClientId = env.EBAY_CLIENT_ID !== undefined;
  const hasClientSecret = env.EBAY_CLIENT_SECRET !== undefined;

  if (hasClientId !== hasClientSecret) {
    throw new ConfigurationError('EBAY_CLIENT_ID and EBAY_CLIENT_SECRET must be supplied together');
  }
  if (!hasClientId && env.NODE_ENV === 'production') {
    throw new ConfigurationError(
      'EBAY_CLIENT_ID and EBAY_CLIENT_SECRET are required when NODE_ENV=production',
    );
  }
  if (env.EBAY_SEARCH_DEFAULT_LIMIT > env.EBAY_SEARCH_MAX_LIMIT) {
    throw new ConfigurationError('EBAY_SEARCH_DEFAULT_LIMIT must not exceed EBAY_SEARCH_MAX_LIMIT');
  }
  if (env.EBAY_DELIVERY_POSTAL_CODE !== undefined && env.EBAY_DELIVERY_COUNTRY === undefined) {
    throw new ConfigurationError(
      'EBAY_DELIVERY_POSTAL_CODE requires EBAY_DELIVERY_COUNTRY to be set as well',
    );
  }
  if (env.EBAY_OAUTH_SCOPES.length === 0) {
    throw new ConfigurationError('EBAY_OAUTH_SCOPES must list at least one OAuth scope');
  }

  const host = EBAY_HOSTS[env.EBAY_ENVIRONMENT];
  return {
    environment: env.EBAY_ENVIRONMENT,
    clientId: env.EBAY_CLIENT_ID,
    clientSecret: env.EBAY_CLIENT_SECRET,
    configured: hasClientId && hasClientSecret,
    apiBaseUrl: host,
    oauthTokenUrl: `${host}/identity/v1/oauth2/token`,
    scopes: env.EBAY_OAUTH_SCOPES,
    defaultMarketplaceId: env.EBAY_MARKETPLACE_ID,
    tokenRefreshSkewMs: env.EBAY_TOKEN_REFRESH_SKEW_MS,
    maxRetries: env.EBAY_MAX_RETRIES,
    retryBaseDelayMs: env.EBAY_RETRY_BASE_DELAY_MS,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    deliveryCountry: env.EBAY_DELIVERY_COUNTRY,
    deliveryPostalCode: env.EBAY_DELIVERY_POSTAL_CODE,
    affiliateCampaignId: env.EBAY_AFFILIATE_CAMPAIGN_ID,
    accountDeletion: buildAccountDeletionConfig(env),
  };
};

export const buildConfig = (env: Env): AppConfig => ({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  service: {
    name: env.SERVICE_NAME,
    version: env.SERVICE_VERSION,
    gitSha: env.GIT_SHA,
    publicBaseUrl: env.PUBLIC_BASE_URL,
  },
  http: {
    host: env.HOST,
    port: env.PORT,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    rateLimit: { max: env.RATE_LIMIT_MAX, windowMs: env.RATE_LIMIT_WINDOW_MS },
  },
  logLevel: env.LOG_LEVEL,
  auth: buildAuthConfig(env),
  ebay: buildEbayConfig(env),
  limits: {
    searchDefaultLimit: env.EBAY_SEARCH_DEFAULT_LIMIT,
    searchMaxLimit: env.EBAY_SEARCH_MAX_LIMIT,
    compareMaxItems: env.EBAY_COMPARE_MAX_ITEMS,
  },
});

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(withoutBlankValues(source));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(`Invalid environment configuration: ${details}`);
  }
  return buildConfig(parsed.data);
};
