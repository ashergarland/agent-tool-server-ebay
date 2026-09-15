import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_PLATFORM_SHA = '98ec8162fb11d5c04aee9e6f7b3625a472a0180d';
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const declarationPath = join(repositoryRoot, 'capability-profiles.json');
const fixturePath = join(
  repositoryRoot,
  'tests',
  'fixtures',
  'deployment',
  'synthetic-hosted-container-provider.deployment.json',
);

interface PublicMutation {
  readonly enablement: 'separate';
  readonly authorization: string;
  readonly confirmation: string;
  readonly durableRecord: 'required' | 'not-required';
  readonly authoritativeVerification: string;
}

interface DeclarationDocument {
  readonly profiles: [{ mutation?: PublicMutation }];
  secretValue?: string;
}

interface PrivateMutation {
  readonly enablement: {
    readonly default: 'disabled';
    readonly reference: string;
  };
  readonly authorization: { readonly reference: string };
  readonly confirmation: { readonly reference: string };
  readonly authoritativeVerification: { readonly expectation: string };
}

interface DeploymentFixtureDocument {
  readonly profile: {
    id: string;
    readonly dimensions: {
      access: string;
      mutation: string;
    };
  };
  readonly source: { revision: string };
  artifact: unknown;
  mutation?: PrivateMutation;
  readonly prerequisites: {
    provider: Array<{ readonly id: string; readonly reference: string }>;
  };
  readonly verification: {
    provider: unknown[];
  };
}

interface ValidatorCase {
  readonly label: string;
  readonly declaration?: string;
  readonly instance?: string;
  readonly valid: boolean;
  readonly expected?: string;
}

const run = (command: string, args: readonly string[], cwd = repositoryRoot) => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
};

const requireSuccessfulCommand = (
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
): string => {
  const result = run(command, args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${String(result.status)}:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
};

const writeJson = async (directory: string, name: string, document: unknown): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
};

const readJson = async <Document>(path: string): Promise<Document> =>
  JSON.parse(await readFile(path, 'utf8')) as Document;

const main = async (): Promise<void> => {
  if (process.versions.node.split('.')[0] !== '22') {
    throw new Error(`Node 22 is required; current runtime is ${process.version}`);
  }

  const checkoutInput = process.env['AGENT_TOOL_PLATFORM_CHECKOUT'];
  if (!checkoutInput) {
    throw new Error(
      'AGENT_TOOL_PLATFORM_CHECKOUT must point to an exact agent-tool-platform source checkout',
    );
  }

  const platformCheckout = resolve(checkoutInput);
  const platformRevision = requireSuccessfulCommand(
    'Platform revision check',
    'git',
    ['-C', platformCheckout, 'rev-parse', 'HEAD'],
    repositoryRoot,
  );
  if (platformRevision !== REQUIRED_PLATFORM_SHA) {
    throw new Error(
      `Expected Platform ${REQUIRED_PLATFORM_SHA}, found ${platformRevision || '(unknown)'}`,
    );
  }

  const validatorPath = join(
    platformCheckout,
    'packages',
    'runtime',
    'bin',
    'validate-deployment.js',
  );
  if (!existsSync(validatorPath)) {
    throw new Error(`Platform deployment validator not found at ${validatorPath}`);
  }

  const invokeValidator = ({
    label,
    declaration = declarationPath,
    instance,
    valid,
    expected,
  }: ValidatorCase): void => {
    const args = [validatorPath, '--declaration', declaration];
    if (instance) args.push('--instance', instance);
    const result = run(process.execPath, args);
    const output = `${result.stdout}${result.stderr}`;

    if (valid && result.status !== 0) {
      throw new Error(`${label} unexpectedly failed:\n${output}`);
    }
    if (!valid && result.status === 0) {
      throw new Error(`${label} unexpectedly passed`);
    }
    if (expected && !output.includes(expected)) {
      throw new Error(`${label} did not report "${expected}":\n${output}`);
    }
    console.log(`PASS ${label}`);
  };

  invokeValidator({ label: 'canonical declaration', valid: true });
  invokeValidator({
    label: 'synthetic hosted deployment instance',
    instance: fixturePath,
    valid: true,
  });

  const declaration = await readJson<DeclarationDocument>(declarationPath);
  const fixture = await readJson<DeploymentFixtureDocument>(fixturePath);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ebay-deployment-contract-'));

  try {
    const unknownProfile = structuredClone(fixture);
    unknownProfile.profile.id = 'unknown-profile';
    invokeValidator({
      label: 'unknown selected profile is rejected',
      instance: await writeJson(temporaryDirectory, 'unknown-profile.json', unknownProfile),
      valid: false,
      expected: 'unknown profile unknown-profile',
    });

    const contradictoryDimensions = structuredClone(fixture);
    contradictoryDimensions.profile.dimensions.access = 'local-process';
    invokeValidator({
      label: 'contradictory hosted access dimension is rejected',
      instance: await writeJson(
        temporaryDirectory,
        'contradictory-dimensions.json',
        contradictoryDimensions,
      ),
      valid: false,
      expected: 'hosted execution requires authenticated-service',
    });

    const mutatingSelection = structuredClone(fixture);
    mutatingSelection.profile.dimensions.mutation = 'mutating';
    mutatingSelection.mutation = {
      enablement: {
        default: 'disabled',
        reference: 'operator-git:synthetic.invalid/ebay-review/mutation-enablement.json',
      },
      authorization: {
        reference: 'operator-git:synthetic.invalid/ebay-review/mutation-authorization.json',
      },
      confirmation: {
        reference: 'operator-git:synthetic.invalid/ebay-review/mutation-confirmation.json',
      },
      authoritativeVerification: {
        expectation: 'Synthetic mutation verification that this read-only profile never supports.',
      },
    };
    invokeValidator({
      label: 'mutating selection against the read-only profile is rejected',
      instance: await writeJson(
        temporaryDirectory,
        'mutating-profile-selection.json',
        mutatingSelection,
      ),
      valid: false,
      expected: 'expected read-only, found mutating',
    });

    const mutationConfiguration = structuredClone(declaration);
    mutationConfiguration.profiles[0].mutation = {
      enablement: 'separate',
      authorization: 'Synthetic authorization that is inappropriate for this read-only profile.',
      confirmation: 'Synthetic confirmation that is inappropriate for this read-only profile.',
      durableRecord: 'not-required',
      authoritativeVerification:
        'Synthetic verification that is inappropriate for this read-only profile.',
    };
    invokeValidator({
      label: 'mutation configuration on the read-only declaration is rejected',
      declaration: await writeJson(
        temporaryDirectory,
        'read-only-with-mutation.json',
        mutationConfiguration,
      ),
      valid: false,
      expected: 'must be omitted for read-only profiles',
    });

    const mutableSource = structuredClone(fixture);
    mutableSource.source.revision = 'main';
    invokeValidator({
      label: 'mutable source revision is rejected',
      instance: await writeJson(temporaryDirectory, 'mutable-source.json', mutableSource),
      valid: false,
      expected: 'source.revision',
    });

    const mutableArtifact = structuredClone(fixture);
    mutableArtifact.artifact = {
      kind: 'container',
      registry: 'registry.synthetic.invalid',
      image: 'chatgpt-ebay',
      sourceBinding: {
        revision: mutableArtifact.source.revision,
        method: 'build-record',
        reference: 'evidence-store:synthetic.invalid/ebay-review/container-build',
      },
    };
    invokeValidator({
      label: 'container selection without an immutable digest is rejected',
      instance: await writeJson(temporaryDirectory, 'mutable-artifact.json', mutableArtifact),
      valid: false,
      expected: 'artifact',
    });

    const secretValue = structuredClone(declaration);
    secretValue.secretValue = 'synthetic-sensitive-material';
    invokeValidator({
      label: 'secret value field is rejected',
      declaration: await writeJson(temporaryDirectory, 'secret-value.json', secretValue),
      valid: false,
      expected: 'secret values are forbidden',
    });

    const missingPrerequisite = structuredClone(fixture);
    missingPrerequisite.prerequisites.provider = missingPrerequisite.prerequisites.provider.filter(
      ({ id }) => id !== 'ebay-developer-keyset',
    );
    invokeValidator({
      label: 'missing provider prerequisite is rejected',
      instance: await writeJson(
        temporaryDirectory,
        'missing-provider-prerequisite.json',
        missingPrerequisite,
      ),
      valid: false,
      expected: 'missing declared prerequisite ebay-developer-keyset',
    });

    const missingProviderVerification = structuredClone(fixture);
    missingProviderVerification.verification.provider = [];
    invokeValidator({
      label: 'missing provider verification is rejected',
      instance: await writeJson(
        temporaryDirectory,
        'missing-provider-verification.json',
        missingProviderVerification,
      ),
      valid: false,
      expected: 'instance.verification.provider',
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  console.log(`Deployment contract validation passed with Platform ${REQUIRED_PLATFORM_SHA}.`);
};

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
