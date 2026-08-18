import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createApplication } from '../../src/app.js';
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

const API_KEY = 'test-api-key-that-is-long-enough-000000';

const connectHttp = async () => {
  const config = testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY });
  const provider = createFakeProvider();
  const app = createApplication({
    config,
    provider,
    logger: createTestLogger() as unknown as Logger,
  });
  const address = await app.http.listen({ host: '127.0.0.1', port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', address), {
    requestInit: { headers: { 'x-api-key': API_KEY } },
  });
  const client = new Client({ name: 'http-test-client', version: '1.0.0' });
  await client.connect(transport as unknown as Transport);
  return { app, client, transport };
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

  it('serves the shared registry over authenticated stateless Streamable HTTP', async () => {
    const { app, client, transport } = await connectHttp();

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      app.registry
        .list()
        .map((tool) => tool.name)
        .sort(),
    );

    await client.close();
    await transport.close();
    await app.http.close();
  });

  it('requires authentication for Streamable HTTP MCP', async () => {
    const app = createApplication({
      config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY }),
      provider: createFakeProvider(),
      logger: createTestLogger() as unknown as Logger,
    });
    const response = await app.http.inject({
      method: 'POST',
      url: '/mcp',
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'unauthenticated-test', version: '1.0.0' },
        },
      },
    });

    expect(response.statusCode).toBe(401);
    await app.http.close();
  });

  it('rejects persistent MCP streams to remain stateless and scale-to-zero compatible', async () => {
    const app = createApplication({
      config: testConfig({ AUTH_MODE: 'api-key', API_KEYS: API_KEY }),
      provider: createFakeProvider(),
      logger: createTestLogger() as unknown as Logger,
    });
    for (const method of ['GET', 'DELETE'] as const) {
      const response = await app.http.inject({
        method,
        url: '/mcp',
        headers: { 'x-api-key': API_KEY },
      });
      expect(response.statusCode).toBe(405);
      expect(response.headers['allow']).toBe('POST');
    }
    await app.http.close();
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
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
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
    const structured = result.structuredContent as {
      kind: string;
      listing: { legacyItemId: string };
    };
    expect(structured.kind).toBe('listing');
    expect(structured.listing.legacyItemId).toBe('407111131587');

    await server.close();
    await client.close();
  });

  it('returns every variation of an item group as structured content', async () => {
    const { client, server } = await connect();

    const result = await client.callTool({
      name: 'ebay_get_item_group',
      arguments: { itemGroup: 'https://www.ebay.com/itm/142373490668' },
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      itemGroup: { itemGroupId: string; items: { itemId: string }[] };
    };
    expect(structured.itemGroup.itemGroupId).toBe('142373490668');
    expect(structured.itemGroup.items).toHaveLength(2);

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
