import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const addFormats = require('ajv-formats') as FormatsPlugin;

const metadataPath = 'server.json';
const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
const packageMetadata = JSON.parse(await readFile('package.json', 'utf8')) as unknown;

const sourceMetadataSchema = z.object({
  $schema: z.url(),
  name: z.literal('io.github.ashergarland/agent-tool-server-ebay'),
  description: z.string().min(1).max(100),
  title: z.literal('eBay Marketplace'),
  repository: z.object({
    url: z.literal('https://github.com/ashergarland/agent-tool-server-ebay'),
    source: z.literal('github'),
  }),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  websiteUrl: z.literal('https://github.com/ashergarland/agent-tool-server-ebay'),
  packages: z.never().optional(),
  remotes: z.never().optional(),
});

const packageSchema = z.object({
  name: z.literal('agent-tool-server-ebay'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  repository: z.object({
    url: z.literal('git+https://github.com/ashergarland/agent-tool-server-ebay.git'),
  }),
  bin: z.object({
    'agent-tool-server-ebay-mcp': z.literal('dist/mcp/stdio.js'),
  }),
  private: z.literal(true),
});

const parsedMetadata = sourceMetadataSchema.parse(metadata);
const parsedPackage = packageSchema.parse(packageMetadata);
if (parsedMetadata.version !== parsedPackage.version) {
  throw new Error('server.json and package.json versions must match');
}

const officialSchema =
  process.env['MCP_SCHEMA_PATH'] === undefined
    ? await (async (): Promise<unknown> => {
        const response = await fetch(parsedMetadata.$schema, {
          headers: {
            accept: 'application/json',
            'user-agent': 'agent-tool-server-ebay-metadata-validator',
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`Unable to load official MCP schema: HTTP ${response.status}`);
        }
        return response.json();
      })()
    : JSON.parse(await readFile(process.env['MCP_SCHEMA_PATH'], 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(officialSchema as object);
if (!validate(metadata)) {
  throw new Error(
    `server.json does not satisfy the official MCP schema: ${ajv.errorsText(validate.errors)}`,
  );
}

process.stdout.write(
  'server.json is valid pre-publication metadata; no package or hosted endpoint is claimed.\n',
);
