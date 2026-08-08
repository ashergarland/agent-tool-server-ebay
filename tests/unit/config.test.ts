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
      service: { name: 'chatgpt-ebay' },
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

  it('rejects an empty scope list', () => {
    expect(() => load({ EBAY_OAUTH_SCOPES: '  ' })).toThrow(/at least one OAuth scope/);
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
