import type { Logger } from 'pino';
import {
  createAccountDeletionService,
  type AccountDeletionService,
} from './compliance/ebay-account-deletion/index.js';
import { loadConfig, type AppConfig } from './config/index.js';
import { createEbayProvider } from './provider/ebay/index.js';
import type { EbayProvider } from './provider/types.js';
import { createServices, type Services } from './services/index.js';
import { createHttpServer } from './server/http.js';
import type { HttpServer } from './server/types.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createLogger } from './util/logger.js';

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly services: Services;
  readonly registry: ToolRegistry;
  readonly http: HttpServer;
  /** Undefined unless the deployment is configured for eBay account-deletion compliance. */
  readonly accountDeletion: AccountDeletionService | undefined;
}

export interface CreateApplicationOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  /** Injectable for tests; defaults to the real eBay Browse API adapter. */
  readonly provider?: EbayProvider;
  /** Injectable for tests; defaults to the configuration-derived compliance service. */
  readonly accountDeletion?: AccountDeletionService | undefined;
}

/**
 * Defers provider construction to the first tool call.
 *
 * Config deliberately allows the eBay credentials to be absent outside production so the service
 * can be started locally to inspect `/health`, `/version`, `/openapi.json` and `/tools`. Building
 * the provider eagerly would turn that into a startup crash, so construction — and the loud error
 * when credentials are missing — happens on first use instead.
 */
const lazyProvider = (config: AppConfig): EbayProvider => {
  let instance: EbayProvider | undefined;
  const resolve = (): EbayProvider => (instance ??= createEbayProvider(config));

  return {
    getListing: (input) => resolve().getListing(input),
    getItemGroup: (input) => resolve().getItemGroup(input),
    searchListings: (input) => resolve().searchListings(input),
  };
};

/**
 * Composition root. Everything is wired here so that tests can substitute the provider without
 * touching any other layer.
 */
export const createApplication = (options: CreateApplicationOptions = {}): Application => {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config);
  const provider = options.provider ?? lazyProvider(config);
  const services = createServices(config, provider, logger);
  const registry = createToolRegistry();
  const accountDeletion = options.accountDeletion ?? createAccountDeletionService(config);

  logger.info(
    {
      event: 'ebay.account_deletion.configuration',
      mounted: accountDeletion !== undefined,
    },
    accountDeletion
      ? 'eBay marketplace account deletion callback is mounted'
      : 'eBay marketplace account deletion callback is not configured; the route is not mounted',
  );

  const http = createHttpServer({ config, logger, services, registry, accountDeletion });

  return { config, logger, services, registry, http, accountDeletion };
};
