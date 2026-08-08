import type { AppConfig } from '../config/index.js';
import { badRequest } from '../errors.js';
import { isMarketplaceId, MARKETPLACE_IDS, type MarketplaceId } from '../provider/ebay/index.js';

/**
 * Central policy object. Every service consults it before touching eBay, so the connector's
 * bounds — result sizes, marketplaces, capability claims — are defined in exactly one place.
 */
export class Guardrails {
  public constructor(private readonly config: AppConfig) {}

  public get defaultMarketplaceId(): MarketplaceId {
    return this.config.ebay.defaultMarketplaceId;
  }

  public get searchDefaultLimit(): number {
    return this.config.limits.searchDefaultLimit;
  }

  public get searchMaxLimit(): number {
    return this.config.limits.searchMaxLimit;
  }

  public get compareMaxItems(): number {
    return this.config.limits.compareMaxItems;
  }

  /** Default buyer location, applied to searches when the caller does not supply one. */
  public get defaultDeliveryCountry(): string | undefined {
    return this.config.ebay.deliveryCountry;
  }

  public get defaultDeliveryPostalCode(): string | undefined {
    return this.config.ebay.deliveryPostalCode;
  }

  public assertMarketplaceSupported(marketplaceId: string): MarketplaceId {
    if (!isMarketplaceId(marketplaceId)) {
      throw badRequest(`'${marketplaceId}' is not a marketplace the eBay Buy APIs support.`, {
        supportedMarketplaceIds: MARKETPLACE_IDS,
      });
    }
    return marketplaceId;
  }

  /**
   * Clamps a caller-requested result count into the configured range. ChatGPT tends to ask for
   * more rows than it can usefully reason about, and every extra row is an extra eBay call quota
   * unit, so the cap is enforced here rather than trusted from the tool schema alone.
   */
  public resolveLimit(requested: number | undefined): number {
    if (requested === undefined) return this.config.limits.searchDefaultLimit;
    if (!Number.isInteger(requested) || requested < 1) {
      throw badRequest('limit must be a positive integer');
    }
    return Math.min(requested, this.config.limits.searchMaxLimit);
  }

  /** Rejects a compare request that names too many items to be answered in one round trip. */
  public assertCompareSize(count: number): void {
    if (count < 2) {
      throw badRequest('compareListings needs at least two items to compare.');
    }
    if (count > this.config.limits.compareMaxItems) {
      throw badRequest(
        `compareListings accepts at most ${this.config.limits.compareMaxItems} items per call; received ${count}.`,
      );
    }
  }
}
