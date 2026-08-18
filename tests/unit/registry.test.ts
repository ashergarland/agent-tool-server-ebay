import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Logger } from 'pino';
import { createToolRegistry } from '../../src/tools/registry.js';
import { toolDefinitions, type ToolDefinition } from '../../src/tools/definitions.js';
import { createServices } from '../../src/services/index.js';
import { ItemGroupError } from '../../src/errors.js';
import type { SearchInput } from '../../src/provider/types.js';
import { testConfig } from '../helpers/config.js';
import { createFakeProvider, createTestLogger } from '../helpers/fake-provider.js';

const context = { requestId: 'req-1', principal: 'test' };

const buildServices = (overrides: Record<string, string | undefined> = {}) => {
  const provider = createFakeProvider();
  const services = createServices(
    testConfig(overrides),
    provider,
    createTestLogger() as unknown as Logger,
  );
  return { provider, services };
};

describe('ToolRegistry', () => {
  const registry = createToolRegistry();

  it('registers every declared tool', () => {
    expect(registry.list()).toHaveLength(toolDefinitions.length);
  });

  it('exposes unique, snake_case, ebay-prefixed tool names', () => {
    const names = registry.list().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^ebay_[a-z0-9_]+$/);
  });

  it('exposes only read tools — this connector changes nothing', () => {
    expect(registry.list().every((tool) => tool.kind === 'read')).toBe(true);
  });

  it('emits input and output JSON schemas for every tool', () => {
    for (const tool of registry.list()) {
      expect(tool.inputJsonSchema).toMatchObject({ type: 'object' });
      expect(tool.outputJsonSchema).toMatchObject({ type: 'object' });
    }
  });

  it('describes sold quantity as an estimate on an active listing, not sales history', () => {
    const schema = registry.get('ebay_get_listing').outputJsonSchema;
    expect(JSON.stringify(schema)).toContain('Estimated sold quantity');
    expect(JSON.stringify(schema)).toContain('not completed-listing history');
  });

  it('gives every tool a description long enough to guide tool choice', () => {
    for (const tool of registry.list()) {
      expect(tool.summary.length).toBeGreaterThan(20);
      expect(tool.description.length).toBeGreaterThan(120);
    }
  });

  it('rejects duplicate tool names', () => {
    const duplicate = toolDefinitions[0] as unknown as ToolDefinition;
    expect(() => createToolRegistry([duplicate, duplicate])).toThrow(/Duplicate tool name/);
  });

  it('throws not_found for unknown tools', () => {
    expect(() => registry.get('ebay_nope')).toThrowError(
      expect.objectContaining({ code: 'not_found' }) as unknown,
    );
  });

  it('validates handler output before returning it to any transport', async () => {
    const invalidOutput = {
      name: 'ebay_invalid_output',
      title: 'Invalid output fixture',
      summary: 'Test-only tool with deliberately invalid handler output.',
      description:
        'This test-only definition proves that every transport receives output validated by the shared registry boundary.',
      kind: 'read',
      inputSchema: z.object({}),
      outputSchema: z.object({ value: z.string() }),
      handler: () => Promise.resolve({ value: 42 }),
    } as unknown as ToolDefinition;
    const { services } = buildServices();

    await expect(
      createToolRegistry([invalidOutput]).invoke('ebay_invalid_output', {}, services, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'internal_error' }) as unknown);
  });
});

describe('tool input validation', () => {
  const registry = createToolRegistry();

  it('rejects a missing required item reference', async () => {
    const { services } = buildServices();
    await expect(registry.invoke('ebay_get_listing', {}, services, context)).rejects.toThrowError(
      expect.objectContaining({ code: 'bad_request' }) as unknown,
    );
  });

  it('reports the offending field path', async () => {
    const { services } = buildServices();
    try {
      await registry.invoke('ebay_get_listing', { item: 42 }, services, context);
      expect.unreachable();
    } catch (error) {
      const details = (error as { details: { issues: { path: string }[] } }).details;
      expect(details.issues[0]?.path).toBe('item');
    }
  });

  it('rejects an unsupported marketplace at the schema boundary', async () => {
    const { services } = buildServices();
    await expect(
      registry.invoke(
        'ebay_get_listing',
        { item: '407111131587', marketplaceId: 'EBAY_IN' },
        services,
        context,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('rejects a search limit beyond the schema maximum', async () => {
    const { services } = buildServices();
    await expect(
      registry.invoke('ebay_search_listings', { query: 'ps2', limit: 500 }, services, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('rejects a comparison of fewer than two items', async () => {
    const { services } = buildServices();
    await expect(
      registry.invoke('ebay_compare_listings', { items: ['407111131587'] }, services, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('applies schema defaults', async () => {
    const { provider, services } = buildServices();
    await registry.invoke('ebay_search_listings', { query: 'ps2' }, services, context);

    const call = provider.calls.find((entry) => entry.name === 'searchListings');
    expect(call?.args[0] as SearchInput).toMatchObject({ limit: 20, offset: 0, sort: 'bestMatch' });
  });
});

describe('tool invocation', () => {
  const registry = createToolRegistry();

  it('returns a listing that matches its declared output schema', async () => {
    const { services } = buildServices();
    const result = await registry.invoke(
      'ebay_get_listing',
      { item: 'https://www.ebay.com/itm/407111131587' },
      services,
      context,
    );

    const tool = registry.get('ebay_get_listing');
    expect(() => tool.outputSchema.parse(result)).not.toThrow();
    const parsed = z
      .object({ listing: z.object({ itemId: z.string(), active: z.boolean() }) })
      .parse(result);
    expect(parsed.listing.itemId).toBe('v1|407111131587|0');
  });

  it('keeps the existing listing payload shape for an ordinary listing', async () => {
    const { services } = buildServices();
    const result = (await registry.invoke(
      'ebay_get_listing',
      { item: 'https://www.ebay.com/itm/407111131587' },
      services,
      context,
    )) as Record<string, unknown>;

    // Backward compatibility: `listing` and `reference` are still populated exactly as before,
    // with `kind` added alongside them rather than replacing anything.
    expect(result['kind']).toBe('listing');
    expect(result['itemGroup']).toBeUndefined();
    expect(result['listing']).toMatchObject({
      itemId: 'v1|407111131587|0',
      legacyItemId: '407111131587',
      title: 'Sony PlayStation 2 Slim Console SCPH-70012 Charcoal Black',
    });
    expect(result['reference']).toMatchObject({
      legacyItemId: '407111131587',
      marketplaceId: 'EBAY_US',
      sourceUrl: 'https://www.ebay.com/itm/407111131587',
    });
  });

  it('reports an item group parent as a group with all of its variations', async () => {
    const provider = createFakeProvider({
      listing: () => {
        throw new ItemGroupError('142373490668');
      },
    });
    const services = createServices(
      testConfig(),
      provider,
      createTestLogger() as unknown as Logger,
    );

    const result = (await registry.invoke(
      'ebay_get_listing',
      { item: 'https://www.ebay.com/itm/142373490668' },
      services,
      context,
    )) as Record<string, unknown>;

    expect(() => registry.get('ebay_get_listing').outputSchema.parse(result)).not.toThrow();
    expect(result['kind']).toBe('itemGroup');
    expect(result['listing']).toBeUndefined();
    expect(result['itemGroup']).toMatchObject({
      itemGroupId: '142373490668',
      itemGroupType: 'SELLER_DEFINED_VARIATIONS',
      varyingAspects: ['Colour'],
    });
  });

  it('returns an item group that matches its declared output schema', async () => {
    const { services } = buildServices();
    const result = await registry.invoke(
      'ebay_get_item_group',
      { itemGroup: '142373490668' },
      services,
      context,
    );

    const tool = registry.get('ebay_get_item_group');
    expect(() => tool.outputSchema.parse(result)).not.toThrow();

    const parsed = z
      .object({
        itemGroup: z.object({
          itemGroupId: z.string(),
          items: z.array(
            z.object({
              itemId: z.string(),
              itemSpecifics: z.array(z.object({ name: z.string() })),
            }),
          ),
        }),
      })
      .parse(result);
    expect(parsed.itemGroup.itemGroupId).toBe('142373490668');
    expect(parsed.itemGroup.items).toHaveLength(2);
    expect(parsed.itemGroup.items[0]?.itemId).toBe('v1|142373490668|623456789012');
  });

  it('rejects an item group reference that carries no group id', async () => {
    const { services } = buildServices();
    await expect(
      registry.invoke('ebay_get_item_group', { itemGroup: 'nintendo 64' }, services, context),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });

  it('returns search results that match the declared output schema', async () => {
    const { services } = buildServices();
    const result = await registry.invoke(
      'ebay_search_listings',
      { query: 'sega saturn' },
      services,
      context,
    );

    expect(() => registry.get('ebay_search_listings').outputSchema.parse(result)).not.toThrow();
    expect(z.object({ activeOnly: z.literal(true) }).parse(result).activeOnly).toBe(true);
  });

  it('returns comparables that match the declared output schema', async () => {
    const { services } = buildServices();
    const result = await registry.invoke(
      'ebay_find_similar_listings',
      { item: '407111131587' },
      services,
      context,
    );

    expect(() =>
      registry.get('ebay_find_similar_listings').outputSchema.parse(result),
    ).not.toThrow();
  });

  it('returns a comparison that matches the declared output schema', async () => {
    const { services } = buildServices();
    const result = await registry.invoke(
      'ebay_compare_listings',
      { items: ['407111131587', '407111131588'] },
      services,
      context,
    );

    expect(() => registry.get('ebay_compare_listings').outputSchema.parse(result)).not.toThrow();
    expect(z.object({ disclaimer: z.string() }).parse(result).disclaimer).toMatch(
      /no buy, bid or valuation recommendation/,
    );
  });

  it('surfaces guardrail failures as AppErrors', async () => {
    const { services } = buildServices({ EBAY_COMPARE_MAX_ITEMS: '2' });
    await expect(
      registry.invoke(
        'ebay_compare_listings',
        { items: ['407111131587', '407111131588', '407111131589'] },
        services,
        context,
      ),
    ).rejects.toThrowError(expect.objectContaining({ code: 'bad_request' }) as unknown);
  });
});
