import { pino, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config/index.js';

export type { Logger };

/**
 * Anything that could carry a bearer token, an eBay OAuth token or the eBay application
 * credentials is redacted before it can reach a log sink.
 */
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'headers.authorization',
  'headers["x-api-key"]',
  'apiKey',
  'password',
  'secret',
  'token',
  'access_token',
  'accessToken',
  'clientSecret',
  'client_secret',
  '*.password',
  '*.secret',
  '*.token',
  '*.access_token',
  '*.accessToken',
  '*.clientSecret',
  '*.client_secret',
];

export const createLogger = (config: AppConfig): Logger => {
  const options: LoggerOptions = {
    level: config.logLevel,
    base: {
      service: config.service.name,
      version: config.service.version,
      env: config.env,
    },
    redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  return pino(options);
};
