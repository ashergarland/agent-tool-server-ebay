import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { createApplication } from '../../src/app.js';
import { testConfig } from '../helpers/config.js';
import { createTestLogger } from '../helpers/fake-provider.js';

const API_KEY = 'test-api-key-that-is-long-enough-000000';

/**
 * Config allows the eBay credentials to be absent outside production. The service must therefore
 * still start and serve its metadata surface; only an actual tool call may fail.
 */
describe('startup without eBay credentials', () => {
  const build = () =>
    createApplication({
      config: testConfig({
        AUTH_MODE: 'api-key',
        API_KEYS: API_KEY,
        EBAY_CLIENT_ID: undefined,
        EBAY_CLIENT_SECRET: undefined,
      }),
      logger: createTestLogger() as unknown as Logger,
    });

  it('builds the application and serves metadata', async () => {
    const app = build();
    await app.http.ready();

    expect(app.config.ebay.configured).toBe(false);

    const health = await app.http.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);

    const version = await app.http.inject({ method: 'GET', url: '/version' });
    expect(version.json()).toMatchObject({ capabilities: { ebayConfigured: false } });

    const openapi = await app.http.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);

    const tools = await app.http.inject({
      method: 'GET',
      url: '/tools',
      headers: { 'x-api-key': API_KEY },
    });
    expect(tools.statusCode).toBe(200);

    await app.http.close();
  });

  it('fails a tool call with an explicit configuration message', async () => {
    const app = build();
    await app.http.ready();

    const response = await app.http.inject({
      method: 'POST',
      url: '/tools/ebay_get_listing',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      payload: { item: '407111131587' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.message).toContain('EBAY_CLIENT_ID');

    await app.http.close();
  });
});
