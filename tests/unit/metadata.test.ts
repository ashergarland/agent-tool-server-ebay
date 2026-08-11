import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

describe('repository metadata', () => {
  it('uses the canonical identity consistently without claiming publication', async () => {
    const [metadata, packageMetadata] = await Promise.all([
      readJson('server.json'),
      readJson('package.json'),
    ]);

    expect(metadata).toMatchObject({
      name: 'io.github.ashergarland/agent-tool-server-ebay',
      title: 'eBay Marketplace',
      version: '0.1.0',
      repository: {
        url: 'https://github.com/ashergarland/agent-tool-server-ebay',
        source: 'github',
      },
    });
    expect(metadata).not.toHaveProperty('packages');
    expect(metadata).not.toHaveProperty('remotes');
    expect(packageMetadata).toMatchObject({
      name: 'agent-tool-server-ebay',
      version: '0.1.0',
      private: true,
      bin: { 'agent-tool-server-ebay-mcp': 'dist/mcp/stdio.js' },
    });
  });

  it('keeps metadata capability claims synchronized with the tool registry', async () => {
    const readme = await readFile('README.md', 'utf8');
    for (const tool of createToolRegistry().list()) {
      expect(tool.kind).toBe('read');
      expect(readme).toContain(`\`${tool.name}\``);
    }
    expect(readme).toContain('active-listing data');
    expect(readme).toContain('does not provide completed-item search');
    expect(readme).toContain('Marketplace Insights API');
  });

  it('documents every intentionally retained legacy deployment identifier', async () => {
    const readme = await readFile('README.md', 'utf8');
    for (const identifier of [
      'rg-chatgpt-ebay-<environment>',
      'ca-chatgpt-ebay-<environment>',
      'cae-chatgpt-ebay-<environment>',
      'id-chatgpt-ebay-<environment>',
      'log-chatgpt-ebay-<environment>',
      'acrchatgptebay',
      'kv-cgeb-',
      'private ACR repository `chatgpt-ebay`',
      '`chatgpt-ebay-...` deployment-history',
    ]) {
      expect(readme).toContain(identifier);
    }
  });
});
