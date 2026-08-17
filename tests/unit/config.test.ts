import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';

const base = {
  NODE_ENV: 'development',
  AUTH_MODE: 'disabled',
} satisfies NodeJS.ProcessEnv;

const load = (overrides: NodeJS.ProcessEnv = {}) => loadConfig({ ...base, ...overrides });

describe('config defaults', () => {
  it('applies sensible defaults', () => {
    const config = load();
    expect(config).toMatchObject({
      env: 'development',
      isProduction: false,
      service: { name: 'agent-tool-server-ebay', version: '0.1.0' },
      http: { host: '0.0.0.0', port: 8080 },
      limits: { searchDefaultLimit: 20, searchMaxLimit: 50, compareMaxItems: 8 },
    });
  });

  it('defaults to the production eBay host and the US marketplace', () => {
    const config = load();
    expect(config.ebay).toMatchObject({
      environment: 'production',
      apiBaseUrl: 'https://api.ebay.com',
      oauthTokenUrl: 'https://api.ebay.com/identity/v1/oauth2/token',
      defaultMarketplaceId: 'EBAY_US',
      scopes: ['https://api.ebay.com/oauth/api_scope'],
    });
  });

  it('switches every eBay URL when the sandbox is selected', () => {
    const config = load({ EBAY_ENVIRONMENT: 'sandbox' });
    expect(config.ebay.apiBaseUrl).toBe('https://api.sandbox.ebay.com');
    expect(config.ebay.oauthTokenUrl).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token');
  });

  it('reports whether eBay credentials are configured', () => {
    expect(load().ebay.configured).toBe(false);
    expect(load({ EBAY_CLIENT_ID: 'id', EBAY_CLIENT_SECRET: 'secret' }).ebay.configured).toBe(true);
  });

  it('coerces numeric environment variables', () => {
    const config = load({ PORT: '9090', EBAY_SEARCH_MAX_LIMIT: '25', RATE_LIMIT_MAX: '5' });
    expect(config.http.port).toBe(9090);
    expect(config.limits.searchMaxLimit).toBe(25);
    expect(config.http.rateLimit.max).toBe(5);
  });

  it('parses comma separated lists', () => {
    const config = load({ EBAY_OAUTH_SCOPES: 'scope-a, scope-b ,scope-c' });
    expect(config.ebay.scopes).toEqual(['scope-a', 'scope-b', 'scope-c']);
  });

  it('uppercases the delivery country', () => {
    expect(load({ EBAY_DELIVERY_COUNTRY: 'us' }).ebay.deliveryCountry).toBe('US');
  });
});

describe('config validation', () => {
  it('rejects an unknown marketplace id', () => {
    expect(() => load({ EBAY_MARKETPLACE_ID: 'EBAY_MOTORS_US' })).toThrow(ConfigurationError);
  });

  it('rejects an out of range port', () => {
    expect(() => load({ PORT: '0' })).toThrow(ConfigurationError);
  });

  it('rejects a malformed public base url', () => {
    expect(() => load({ PUBLIC_BASE_URL: 'not-a-url' })).toThrow(ConfigurationError);
  });

  it('rejects a non ISO delivery country', () => {
    expect(() => load({ EBAY_DELIVERY_COUNTRY: 'USA' })).toThrow(ConfigurationError);
  });

  it('rejects a non numeric affiliate campaign id', () => {
    expect(() => load({ EBAY_AFFILIATE_CAMPAIGN_ID: 'campaign-1' })).toThrow(ConfigurationError);
  });

  it('rejects a postal code with no country', () => {
    expect(() => load({ EBAY_DELIVERY_POSTAL_CODE: '19406' })).toThrow(
      /requires EBAY_DELIVERY_COUNTRY/,
    );
  });

  it('accepts a postal code together with a country', () => {
    const config = load({ EBAY_DELIVERY_COUNTRY: 'US', EBAY_DELIVERY_POSTAL_CODE: '19406' });
    expect(config.ebay.deliveryPostalCode).toBe('19406');
  });

  it('rejects a client id with no secret', () => {
    expect(() => load({ EBAY_CLIENT_ID: 'id' })).toThrow(/must be supplied together/);
  });

  it('rejects a secret with no client id', () => {
    expect(() => load({ EBAY_CLIENT_SECRET: 'secret' })).toThrow(/must be supplied together/);
  });

  it('rejects a default limit greater than the maximum', () => {
    expect(() => load({ EBAY_SEARCH_DEFAULT_LIMIT: '50', EBAY_SEARCH_MAX_LIMIT: '10' })).toThrow(
      /must not exceed/,
    );
  });

  it('rejects a scope list that contains no usable scopes', () => {
    // A blank value means "not set" and falls back to the default scope, but a value that is
    // present and yet yields nothing usable is a genuine misconfiguration.
    expect(() => load({ EBAY_OAUTH_SCOPES: ',,' })).toThrow(/at least one OAuth scope/);
  });

  it('falls back to the default scope when the value is blank', () => {
    expect(load({ EBAY_OAUTH_SCOPES: '  ' }).ebay.scopes).toEqual([
      'https://api.ebay.com/oauth/api_scope',
    ]);
  });
});

describe('authentication configuration', () => {
  it('requires at least one api key in api-key mode', () => {
    expect(() => load({ AUTH_MODE: 'api-key' })).toThrow(/at least one value in API_KEYS/);
  });

  it('rejects short api keys', () => {
    expect(() => load({ AUTH_MODE: 'api-key', API_KEYS: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('accepts multiple long api keys', () => {
    const keys = ['a'.repeat(32), 'b'.repeat(40)].join(',');
    const config = load({ AUTH_MODE: 'api-key', API_KEYS: keys });
    expect(config.auth).toMatchObject({
      mode: 'api-key',
      apiKeys: ['a'.repeat(32), 'b'.repeat(40)],
    });
  });

  it('refuses to disable authentication in production', () => {
    expect(() =>
      load({
        NODE_ENV: 'production',
        AUTH_MODE: 'disabled',
        EBAY_CLIENT_ID: 'id',
        EBAY_CLIENT_SECRET: 'secret',
      }),
    ).toThrow(/not permitted when NODE_ENV=production/);
  });
});

describe('production requirements', () => {
  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'api-key',
    API_KEYS: 'k'.repeat(32),
  } satisfies NodeJS.ProcessEnv;

  it('requires eBay credentials in production', () => {
    expect(() => loadConfig(production)).toThrow(/required when NODE_ENV=production/);
  });

  it('accepts a fully configured production environment', () => {
    const config = loadConfig({
      ...production,
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
    });
    expect(config.isProduction).toBe(true);
    expect(config.ebay.configured).toBe(true);
  });
});

/**
 * Azure Container Apps materialises an unset template value as an empty string, and the first
 * provisioning pass genuinely has no public URL to supply. Treating those as "not set" is what
 * keeps the container from exiting at startup on a clean deployment.
 */
describe('blank environment values', () => {
  const deployed = {
    NODE_ENV: 'production',
    AUTH_MODE: 'api-key',
    API_KEYS: 'k'.repeat(32),
    EBAY_CLIENT_ID: 'id',
    EBAY_CLIENT_SECRET: 'secret',
  } satisfies NodeJS.ProcessEnv;

  it('treats an empty PUBLIC_BASE_URL as absent rather than an invalid URL', () => {
    const config = loadConfig({ ...deployed, PUBLIC_BASE_URL: '' });
    expect(config.service.publicBaseUrl).toBeUndefined();
  });

  it('treats empty delivery context values as absent', () => {
    const config = loadConfig({
      ...deployed,
      EBAY_DELIVERY_COUNTRY: '',
      EBAY_DELIVERY_POSTAL_CODE: '',
    });
    expect(config.ebay.deliveryCountry).toBeUndefined();
    expect(config.ebay.deliveryPostalCode).toBeUndefined();
  });

  it('ignores whitespace-only values', () => {
    const config = loadConfig({ ...deployed, EBAY_AFFILIATE_CAMPAIGN_ID: '   ' });
    expect(config.ebay.affiliateCampaignId).toBeUndefined();
  });

  it('falls back to the default when an optional enum is blank', () => {
    const config = loadConfig({ ...deployed, EBAY_MARKETPLACE_ID: '', EBAY_ENVIRONMENT: '' });
    expect(config.ebay.defaultMarketplaceId).toBe('EBAY_US');
    expect(config.ebay.environment).toBe('production');
  });

  it('still rejects a genuinely invalid value', () => {
    expect(() => loadConfig({ ...deployed, PUBLIC_BASE_URL: 'not-a-url' })).toThrow(
      ConfigurationError,
    );
  });

  it('accepts the exact environment the Container App template produces', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '8080',
      LOG_LEVEL: 'info',
      SERVICE_NAME: 'agent-tool-server-ebay',
      AUTH_MODE: 'api-key',
      API_KEYS: 'k'.repeat(32),
      EBAY_CLIENT_ID: 'id',
      EBAY_CLIENT_SECRET: 'secret',
      EBAY_ENVIRONMENT: 'production',
      EBAY_MARKETPLACE_ID: 'EBAY_US',
    });
    expect(config.isProduction).toBe(true);
    expect(config.ebay.configured).toBe(true);
    expect(config.service.publicBaseUrl).toBeUndefined();
  });
});

/**
 * eBay Marketplace Account Deletion/Closure compliance configuration. The verification token is a
 * secret: it must never reach a response, a log line or a validation error.
 */
describe('account deletion configuration', () => {
  const TOKEN = 'example-compliance-verification-token-0001';
  const ENDPOINT = 'https://connector.example.com/ebay/notifications/marketplace-account-deletion';

  const production = {
    NODE_ENV: 'production',
    AUTH_MODE: 'api-key',
    API_KEYS: 'k'.repeat(32),
    EBAY_CLIENT_ID: 'id',
    EBAY_CLIENT_SECRET: 'secret',
  } satisfies NodeJS.ProcessEnv;

  it('accepts a valid production configuration', () => {
    const config = loadConfig({
      ...production,
      EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT,
      EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
    });

    expect(config.ebay.accountDeletion).toEqual({
      endpointUrl: ENDPOINT,
      verificationToken: TOKEN,
    });
  });

  it('preserves the endpoint URL byte for byte, including a trailing slash', () => {
    const config = loadConfig({
      ...production,
      EBAY_ACCOUNT_DELETION_ENDPOINT_URL: `${ENDPOINT}/`,
      EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
    });

    expect(config.ebay.accountDeletion?.endpointUrl).toBe(`${ENDPOINT}/`);
  });

  it('leaves compliance unconfigured when neither value is supplied', () => {
    expect(load().ebay.accountDeletion).toBeUndefined();
  });

  it('treats blank deployment values as unset rather than invalid', () => {
    const config = loadConfig({
      ...production,
      EBAY_ACCOUNT_DELETION_ENDPOINT_URL: '',
      EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: '',
    });

    expect(config.ebay.accountDeletion).toBeUndefined();
  });

  it('keeps the token alone harmless while the endpoint URL is still unknown', () => {
    const config = loadConfig({
      ...production,
      EBAY_ACCOUNT_DELETION_ENDPOINT_URL: '',
      EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
    });

    expect(config.ebay.accountDeletion).toBeUndefined();
  });

  it('requires a verification token once an endpoint URL is configured', () => {
    expect(() =>
      loadConfig({ ...production, EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a malformed endpoint URL', () => {
    expect(() =>
      loadConfig({
        ...production,
        EBAY_ACCOUNT_DELETION_ENDPOINT_URL: 'not-a-url',
        EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects a plaintext HTTP endpoint in production', () => {
    expect(() =>
      loadConfig({
        ...production,
        EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT.replace('https://', 'http://'),
        EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
      }),
    ).toThrow(/https/);
  });

  it('allows a plaintext HTTP endpoint outside production for local testing', () => {
    const config = load({
      EBAY_ACCOUNT_DELETION_ENDPOINT_URL:
        'http://localhost:8080/ebay/notifications/marketplace-account-deletion',
      EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
    });

    expect(config.ebay.accountDeletion?.endpointUrl).toContain('http://localhost');
  });

  it('rejects an endpoint URL carrying a query string or fragment', () => {
    for (const suffix of ['?a=b', '#fragment']) {
      expect(() =>
        loadConfig({
          ...production,
          EBAY_ACCOUNT_DELETION_ENDPOINT_URL: `${ENDPOINT}${suffix}`,
          EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: TOKEN,
        }),
      ).toThrow(ConfigurationError);
    }
  });

  it.each([
    ['too short', 'a'.repeat(31)],
    ['too long', 'a'.repeat(81)],
    ['containing a space', `${'a'.repeat(31)} `],
    ['containing punctuation', `${'a'.repeat(31)}!`],
    ['containing a slash', `${'a'.repeat(31)}/`],
  ])('rejects a verification token that is %s', (_label, token) => {
    expect(() =>
      loadConfig({
        ...production,
        EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT,
        EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: token,
      }),
    ).toThrow(ConfigurationError);
  });

  it.each([
    ['exactly 32 characters', 'a'.repeat(32)],
    ['exactly 80 characters', 'a'.repeat(80)],
    ['hyphens and underscores', `token_with-mixed_CHARS-${'0'.repeat(12)}`],
    ['48 hexadecimal characters, as provisioning generates', '0123456789abcdef'.repeat(3)],
  ])('accepts a verification token with %s', (_label, token) => {
    expect(
      loadConfig({
        ...production,
        EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT,
        EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: token,
      }).ebay.accountDeletion?.verificationToken,
    ).toBe(token);
  });

  it('never includes the verification token in a validation failure', () => {
    const token = `${'a'.repeat(40)}!!`;
    try {
      loadConfig({
        ...production,
        EBAY_ACCOUNT_DELETION_ENDPOINT_URL: ENDPOINT,
        EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN: token,
      });
      expect.unreachable('expected a rejection');
    } catch (error) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).not.toContain(token);
      expect(serialised).toContain('EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN');
    }
  });
});
