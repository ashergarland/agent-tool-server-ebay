import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { createServices } from '../../src/services/index.js';
import { createToolRegistry } from '../../src/tools/registry.js';
import { testConfig } from '../helpers/config.js';
import { createFakeProvider, createTestLogger } from '../helpers/fake-provider.js';

const connect = async () => {
  const config = testConfig();
  const provider = createFakeProvider();
  const services = createServices(config, provider, createTestLogger() as unknown as Logger);
  const registry = createToolRegistry();
  const server = createMcpServer(config, registry, services);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server, provider, registry };
};

describe('MCP transport', () => {
  it('exposes exactly the tools in the shared registry', async () => {
    const { client, server, registry } = await connect();

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    );

    await server.close();
    await client.close();
  });

  it('annotates every tool as read-only and non-destructive', async () => {
    const { client, server } = await connect();

    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }

    await server.close();
    await client.close();
  });

  it('invokes a tool and returns structured content', async () => {
    const { client, server } = await connect();

    const result = await client.callTool({
      name: 'ebay_get_listing',
      arguments: { item: 'https://www.ebay.com/itm/407111131587' },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { listing: { legacyItemId: string } };
    expect(structured.listing.legacyItemId).toBe('407111131587');

    await server.close();
    await client.close();
  });

  it('reports a validation failure as a tool error rather than a protocol error', async () => {
    const { client, server } = await connect();

    const result = await client.callTool({
      name: 'ebay_get_listing',
      arguments: { item: 'not an ebay listing' },
    });

    expect(result.isError).toBe(true);
    const [content] = result.content as { text: string }[];
    expect(JSON.parse(content?.text ?? '{}')).toMatchObject({ code: 'bad_request' });

    await server.close();
    await client.close();
  });
});
