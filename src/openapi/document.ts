import type { AppConfig } from '../config/index.js';
import type { RegisteredTool, ToolRegistry } from '../tools/registry.js';

type JsonObject = Record<string, unknown>;

const errorSchema: JsonObject = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message', 'retryable', 'requestId'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: {},
        retryable: { type: 'boolean' },
        requestId: { type: 'string' },
      },
    },
  },
};

const errorResponses: JsonObject = {
  '400': {
    description: 'Invalid input, unparseable eBay URL or unsupported marketplace',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '401': {
    description: 'Missing or invalid credentials',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '403': {
    description: 'The connector is not authorised for this eBay resource',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '404': {
    description: 'Unknown tool, or the eBay listing does not exist on this marketplace',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '429': {
    description: 'Rate limited by the connector or by eBay',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '500': {
    description: 'Connector failure',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '502': {
    description: 'eBay API upstream failure',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  '504': {
    description: 'eBay API timed out',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
};

const toolPath = (tool: RegisteredTool): JsonObject => ({
  post: {
    operationId: tool.name,
    summary: tool.summary,
    description: tool.description,
    tags: [tool.kind === 'write' ? 'operations' : 'read'],
    'x-openai-isConsequential': tool.kind === 'write',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: tool.inputJsonSchema } },
    },
    responses: {
      '200': {
        description: 'Tool result',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['tool', 'requestId', 'result'],
              properties: {
                tool: { type: 'string' },
                requestId: { type: 'string' },
                result: tool.outputJsonSchema,
              },
            },
          },
        },
      },
      ...errorResponses,
    },
  },
});

/**
 * Emits the OpenAPI 3.1 document that ChatGPT consumes to discover the connector's actions.
 * Every tool in the registry becomes exactly one POST operation, so the HTTP surface and the tool
 * surface can never drift apart.
 */
export const buildOpenApiDocument = (config: AppConfig, registry: ToolRegistry): JsonObject => {
  const paths: JsonObject = {
    '/health': {
      get: {
        operationId: 'health',
        summary: 'Liveness probe.',
        security: [],
        responses: {
          '200': {
            description: 'Service is alive',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'service', 'uptimeSeconds'],
                  properties: {
                    status: { type: 'string', enum: ['ok'] },
                    service: { type: 'string' },
                    uptimeSeconds: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/version': {
      get: {
        operationId: 'version',
        summary: 'Build and capability information.',
        security: [],
        responses: {
          '200': {
            description: 'Version and capability metadata',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/tools': {
      get: {
        operationId: 'listTools',
        summary: 'List the tools exposed by this connector.',
        responses: {
          '200': {
            description: 'Tool catalogue',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          ...errorResponses,
        },
      },
    },
  };

  for (const tool of registry.list()) {
    paths[`/tools/${tool.name}`] = toolPath(tool);
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ChatGPT eBay Connector',
      version: config.service.version,
      description:
        'Backend connector that retrieves real eBay listings through the official eBay Browse ' +
        'API so that answers are grounded in the actual listing rather than a scraped web page. ' +
        'Given an eBay URL or item id it returns normalised price, shipping, auction, condition, ' +
        'seller, returns and item-specifics data, searches the live market, finds comparable ' +
        'active listings and compares several listings side by side. ' +
        'Important limitation: the eBay Browse API exposes **active listings only**. This ' +
        'connector cannot retrieve sold or completed prices, so all figures are asking prices ' +
        'and current bids, never realised sale prices. The connector supplies evidence only and ' +
        'makes no buy, bid or valuation recommendation.',
    },
    servers: [{ url: config.service.publicBaseUrl ?? `http://localhost:${config.http.port}` }],
    security: config.auth.mode === 'disabled' ? [] : [{ bearerAuth: [] }],
    components: {
      schemas: { Error: errorSchema },
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Static connector API key. May also be supplied in the x-api-key header. This is the ' +
            "connector's own credential and is unrelated to any eBay developer credential.",
        },
      },
    },
    paths,
    tags: [
      { name: 'read', description: 'Read-only eBay listing retrieval and research.' },
      { name: 'operations', description: 'Reserved; this connector exposes no state changes.' },
    ],
  };
};
