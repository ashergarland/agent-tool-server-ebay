import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createToolRegistry } from '../../src/tools/registry.js';

const repoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');

const readJson = (relativePath: string): unknown => JSON.parse(repoFile(relativePath)) as unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const objectAt = (root: unknown, ...path: readonly string[]): Record<string, unknown> => {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) throw new Error(`Expected object at ${path.join('.')}`);
    current = current[segment];
  }
  if (!isRecord(current)) throw new Error(`Expected object at ${path.join('.') || '(root)'}`);
  return current;
};

const arrayAt = (root: unknown, ...path: readonly string[]): unknown[] => {
  let current = root;
  for (const segment of path) {
    if (!isRecord(current)) throw new Error(`Expected object at ${path.join('.')}`);
    current = current[segment];
  }
  if (!Array.isArray(current)) throw new Error(`Expected array at ${path.join('.')}`);
  return current;
};

const declaration = readJson('capability-profiles.json');
const fixture = readJson(
  'tests/fixtures/deployment/synthetic-hosted-container-provider.deployment.json',
);
const serverMetadata = readJson('server.json');

describe('eBay deployment contract declaration', () => {
  const profile = objectAt(arrayAt(declaration, 'profiles')[0]);
  const expectedDimensions = {
    execution: 'hosted',
    delivery: 'container',
    access: 'authenticated-service',
    workload: 'provider',
    provider: 'external',
    mutation: 'read-only',
  };

  it('uses the stable public capability identity and one reusable profile', () => {
    expect(declaration).toMatchObject({
      contractVersion: 1,
      kind: 'capability-profile-declaration',
      capability: {
        id: objectAt(serverMetadata)['name'],
        displayName: objectAt(serverMetadata)['title'],
        repository: objectAt(serverMetadata, 'repository')['url'],
      },
    });
    expect(arrayAt(declaration, 'profiles')).toHaveLength(1);
    expect(profile['id']).toBe('hosted-container-provider');
  });

  it('declares the truthful read-only dimensions without mutation semantics', () => {
    expect(objectAt(profile, 'dimensions')).toEqual(expectedDimensions);
    expect(profile).not.toHaveProperty('mutation');
    expect(
      createToolRegistry()
        .list()
        .every((tool) => tool.kind === 'read'),
    ).toBe(true);
  });

  it('references the existing bounded deployment interface and mechanics', () => {
    expect(objectAt(profile, 'delivery')).toMatchObject({
      supportedForms: ['container'],
      publication: { kind: 'container', identifier: 'chatgpt-ebay' },
      entrypoint: { reference: 'dist/index.js', interface: 'http' },
      provenance: { method: 'build-recipe', reference: 'Dockerfile' },
    });
    expect(objectAt(profile, 'configuration')).toEqual({
      schema: {
        id: 'urn:io.github.ashergarland:agent-tool-server-ebay:deployment-parameters:v1',
        capabilityId: 'io.github.ashergarland/agent-tool-server-ebay',
        path: 'infra/main.bicep',
      },
      bounded: true,
    });

    const mechanicReferences = arrayAt(profile, 'delivery', 'mechanics').map(
      (mechanic) => objectAt(mechanic)['reference'],
    );
    expect(mechanicReferences).toEqual([
      'Dockerfile',
      'infra/main.bicep',
      'scripts/bootstrap/provision.sh',
      'scripts/bootstrap/deploy.sh',
    ]);
  });

  it('keeps required secret names synchronized with existing deployment wiring', () => {
    const requiredSecrets = arrayAt(profile, 'requiredSecrets');
    expect(requiredSecrets).toEqual([
      'connector-api-key',
      'ebay-client-id',
      'ebay-client-secret',
      'ebay-account-deletion-token',
    ]);

    const commonScript = repoFile('scripts/bootstrap/common.sh');
    const containerApp = repoFile('infra/modules/container-app.bicep');
    for (const secretName of requiredSecrets) {
      expect(secretName).toEqual(expect.any(String));
      expect(commonScript).toContain(`'${String(secretName)}'`);
      expect(containerApp).toContain(`'${String(secretName)}'`);
    }
  });

  it('declares provider readiness separately and needs no capability extension', () => {
    expect(arrayAt(profile, 'verification', 'surfaces')).toEqual([
      'identity',
      'readiness',
      'version',
      'behavior',
      'provider',
      'provenance',
    ]);
    expect(arrayAt(profile, 'providerPrerequisites')).toHaveLength(3);
    expect(arrayAt(profile, 'extensionSchemas')).toEqual([]);
  });

  it('keeps the deployment fixture visibly synthetic and read-only', () => {
    expect(objectAt(fixture, 'environment')).toEqual({
      name: 'synthetic-review',
      classification: 'test',
    });
    expect(objectAt(fixture, 'profile', 'dimensions')).toEqual(expectedDimensions);
    expect(objectAt(fixture)).not.toHaveProperty('mutation');
    expect(objectAt(fixture, 'declaration')['revision']).toBe('1'.repeat(40));
    expect(objectAt(fixture, 'source')['revision']).toBe('2'.repeat(40));
    expect(JSON.stringify(fixture)).toContain('synthetic.invalid');
    expect(JSON.stringify(fixture)).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
    );
  });
});
