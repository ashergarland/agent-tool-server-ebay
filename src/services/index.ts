import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import type { EbayProvider } from '../provider/types.js';
import { ComparisonService } from './comparison.js';
import { Guardrails } from './guardrails.js';
import { ListingsService } from './listings.js';

export { ComparisonService, Guardrails, ListingsService };

export interface Services {
  readonly guardrails: Guardrails;
  readonly listings: ListingsService;
  readonly comparison: ComparisonService;
}

export const createServices = (
  config: AppConfig,
  provider: EbayProvider,
  _logger: Logger,
): Services => {
  const guardrails = new Guardrails(config);
  const listings = new ListingsService(provider, guardrails);
  return {
    guardrails,
    listings,
    comparison: new ComparisonService(provider, listings, guardrails),
  };
};
