import { buildConfig, envSchema, type AppConfig } from '../../src/config/index.js';

/** Build an AppConfig for tests without touching process.env. */
export const testConfig = (overrides: Record<string, string | undefined> = {}): AppConfig =>
  buildConfig(
    envSchema.parse({
      NODE_ENV: 'test',
      AUTH_MODE: 'disabled',
      LOG_LEVEL: 'silent',
      SERVICE_VERSION: '1.2.3',
      EBAY_CLIENT_ID: 'test-client-id',
      EBAY_CLIENT_SECRET: 'test-client-secret',
      ...overrides,
    }),
  );
