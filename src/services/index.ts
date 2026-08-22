import type { Logger } from 'pino';
import type { AppConfig } from '../config/index.js';
import { EbayShortLinkResolver, type ItemReferenceResolver } from '../provider/ebay/short-links.js';
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
  itemReferenceResolver: ItemReferenceResolver = new EbayShortLinkResolver(),
): Services => {
  const guardrails = new Guardrails(config);
  const listings = new ListingsService(provider, guardrails, itemReferenceResolver);
  return {
    guardrails,
    listings,
    comparison: new ComparisonService(provider, listings, guardrails),
  };
};
