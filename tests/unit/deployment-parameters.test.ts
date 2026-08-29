import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Deployment parameter integrity.
 *
 * `deploy.sh` used to invoke `infra/main.bicep` with only a handful of its parameters, so every
 * release silently reapplied the Bicep default for anything an operator had configured: the eBay
 * environment, the marketplace, the buyer delivery context, the log level, scaling and alerting.
 *
 * These assertions make that regression impossible to reintroduce quietly. A new operator-facing
 * parameter must either be added to the committed portable parameter baselines or be explicitly
 * declared here as a release-specific value that the scripts pass on the command line.
 */

const repoFile = (relativePath: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)), 'utf8');

const mainBicep = repoFile('infra/main.bicep');
const containerAppBicep = repoFile('infra/modules/container-app.bicep');
const provisionScript = repoFile('scripts/bootstrap/provision.sh');
const deployScript = repoFile('scripts/bootstrap/deploy.sh');
const commonScript = repoFile('scripts/bootstrap/common.sh');

const portableParameterFiles = {
  prod: 'infra/parameters/prod.parameters.json',
  dev: 'infra/parameters/dev.parameters.json',
} as const;

/**
 * Parameters that must NOT live in a committed environment file.
 *
 * `image`, `publicBaseUrl` and `accountDeletionEndpointUrl` are derived per release from the Git
 * commit and the Container Apps ingress hostname; `deployApp` and `resourceGroupName` are
 * bootstrap mechanics rather than environment configuration.
 */
const RELEASE_SPECIFIC_PARAMETERS = new Set([
  'image',
  'publicBaseUrl',
  'accountDeletionEndpointUrl',
  'deployApp',
  'resourceGroupName',
]);

const declaredParameters = (template: string): string[] =>
  [...template.matchAll(/^param\s+([A-Za-z0-9_]+)\s+/gm)].map((match) => match[1] as string);

const parameterFileValues = (relativePath: string): Record<string, unknown> => {
  const parsed = JSON.parse(repoFile(relativePath)) as { parameters: Record<string, unknown> };
  return parsed.parameters;
};

describe('infra/main.bicep parameters', () => {
  const declared = declaredParameters(mainBicep);

  it('declares the parameters the connector needs to stay configured', () => {
    expect(declared).toEqual(
      expect.arrayContaining([
        'environmentName',
        'location',
        'ebayEnvironment',
        'ebayMarketplaceId',
        'ebayDeliveryCountry',
        'ebayDeliveryPostalCode',
        'logLevel',
        'tags',
        'enableHealthAlerts',
        'alertEmails',
        'alertSmsPhone',
        'alertSmsCountryCode',
        'minReplicas',
        'maxReplicas',
        'accountDeletionEndpointUrl',
      ]),
    );
  });

  it.each(Object.entries(portableParameterFiles))(
    'pins every operator-configurable parameter in the portable %s baseline',
    (_environment, relativePath) => {
      const configured = new Set(Object.keys(parameterFileValues(relativePath)));
      const missing = declared.filter(
        (name) => !RELEASE_SPECIFIC_PARAMETERS.has(name) && !configured.has(name),
      );

      expect(missing).toEqual([]);
    },
  );

  it.each(Object.entries(portableParameterFiles))(
    'keeps release-specific values out of the portable %s baseline',
    (_environment, relativePath) => {
      const configured = Object.keys(parameterFileValues(relativePath));
      const leaked = configured.filter((name) => RELEASE_SPECIFIC_PARAMETERS.has(name));

      expect(leaked).toEqual([]);
    },
  );

  it.each(Object.entries(portableParameterFiles))(
    'declares no parameter the template does not accept in the portable %s baseline',
    (_environment, relativePath) => {
      const unknown = Object.keys(parameterFileValues(relativePath)).filter(
        (name) => !declared.includes(name),
      );

      expect(unknown).toEqual([]);
    },
  );

  it.each(Object.entries(portableParameterFiles))(
    'commits no account-specific value in the portable %s baseline',
    (_environment, relativePath) => {
      const values = parameterFileValues(relativePath);
      const raw = repoFile(relativePath);

      expect(values['alertEmails']).toEqual({ value: [] });
      expect(values['alertSmsPhone']).toEqual({ value: '' });
      // Subscription and tenant identifiers, e-mail addresses and long random strings that could
      // be a credential must never appear in a committed parameter file.
      expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(raw).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    },
  );
});

describe('bootstrap scripts', () => {
  const scripts = { 'provision.sh': provisionScript, 'deploy.sh': deployScript } as const;

  it.each(Object.entries(scripts))('%s resolves the selected parameter file', (_name, script) => {
    expect(script).toContain('resolve_parameter_files');
    expect(script).toContain('source "${REPO_ROOT}/scripts/bootstrap/common.sh"');
  });

  it.each(Object.entries(scripts))(
    '%s passes the parameter file to every subscription deployment',
    (_name, script) => {
      const deployments = [...script.matchAll(/az deployment sub create\b[\s\S]*?--output none/g)];
      expect(deployments.length).toBeGreaterThan(0);

      for (const [invocation] of deployments) {
        expect(invocation).toContain('"${PARAMETER_ARGS[@]}"');
        expect(invocation).toContain('--template-file "${REPO_ROOT}/infra/main.bicep"');
      }
    },
  );

  it('accepts an operator-supplied parameter file as the fourth argument', () => {
    expect(provisionScript).toContain('PARAMETER_FILE_ARG="${4:-}"');
    expect(deployScript).toContain('PARAMETER_FILE_ARG="${4:-}"');
  });

  it('defaults to the committed per-environment file and layers a gitignored overlay', () => {
    expect(commonScript).toContain('infra/parameters/${environment}.parameters.json');
    expect(commonScript).toContain('.local.parameters.json');
  });

  it('fails loudly when the parameter file is missing rather than deploying defaults', () => {
    expect(commonScript).toContain('Parameter file not found');
    expect(commonScript).toMatch(/exit 1/);
  });

  it('never writes a secret value into the deployment command line', () => {
    for (const script of [provisionScript, deployScript]) {
      expect(script).not.toMatch(/--parameters\s+\S*[Ss]ecret=/);
      expect(script).not.toMatch(/--parameters\s+\S*[Tt]oken=/);
    }
  });

  it('prints retrieval commands for the secrets instead of the secrets themselves', () => {
    for (const script of [provisionScript, deployScript]) {
      expect(script).toContain('az keyvault secret show --vault-name');
      expect(script).toContain('--name ${SECRET_ACCOUNT_DELETION_TOKEN} --query value -o tsv');
    }
  });
});

describe('eBay account deletion wiring', () => {
  it('passes the Key Vault secret URI into the container app', () => {
    expect(mainBicep).toContain(
      "ebayAccountDeletionTokenSecretUri: '${keyVault.outputs.uri}secrets/ebay-account-deletion-token'",
    );
  });

  it('mounts the verification token as a managed secret reference, never as a literal', () => {
    expect(containerAppBicep).toContain("name: 'ebay-account-deletion-token'");
    expect(containerAppBicep).toContain('keyVaultUrl: ebayAccountDeletionTokenSecretUri');
    expect(containerAppBicep).toContain("secretRef: 'ebay-account-deletion-token'");
    expect(containerAppBicep).toContain('EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN');
    // The token must never be a template parameter: parameters are recorded in deployment history.
    expect(containerAppBicep).not.toMatch(/^param\s+\w*[Vv]erificationToken/m);
    expect(mainBicep).not.toMatch(/^param\s+\w*[Vv]erificationToken/m);
  });

  it('supplies the callback URL only as a release-specific override', () => {
    expect(containerAppBicep).toContain('EBAY_ACCOUNT_DELETION_ENDPOINT_URL');
    expect(deployScript).toContain('--parameters "accountDeletionEndpointUrl=${CALLBACK_URL}"');
    expect(provisionScript).toContain('--parameters "accountDeletionEndpointUrl=${CALLBACK_URL}"');
  });

  it('uses one callback path across the template, the scripts and the route', () => {
    const path = '/ebay/notifications/marketplace-account-deletion';
    expect(mainBicep).toContain(path);
    expect(commonScript).toContain(`ACCOUNT_DELETION_PATH='${path}'`);
    expect(repoFile('src/compliance/ebay-account-deletion/routes.ts')).toContain(
      `ACCOUNT_DELETION_ROUTE_PATH = '${path}'`,
    );
  });

  it('generates a verification token that satisfies eBay\u2019s documented rules', () => {
    // 24 random bytes rendered as hex is 48 characters drawn from [0-9a-f]: inside eBay's 32-80
    // character limit and its alphanumeric/underscore/hyphen alphabet.
    expect(provisionScript).toContain(
      'ensure_secret "${KEY_VAULT}" "${SECRET_ACCOUNT_DELETION_TOKEN}" "$(openssl rand -hex 24)"',
    );
  });

  it('never rotates an existing secret on a rerun', () => {
    expect(commonScript).toContain('existing value left untouched');
    expect(deployScript).not.toContain('az keyvault secret set');
  });

  it('refuses to write when a Key Vault read fails for a reason other than absence', () => {
    // Treating a throttled, unauthorised or transient read as "absent" would silently rotate a
    // live connector API key or eBay verification token on the next provisioning run.
    expect(commonScript).toContain('could not determine whether the secret exists');
    expect(commonScript).toContain(
      "grep -qiE 'secretnotfound|was not found in this key vault|resourcenotfound'",
    );
  });

  it('never falls back to a placeholder eBay credential inline', () => {
    // The old form was `ensure_secret ... "${EBAY_CLIENT_ID:-REPLACE_WITH_EBAY_APP_ID}"`, which
    // wrote a placeholder whenever the variable was unset. Because an existing secret is never
    // overwritten, that placeholder then survived every later provisioning run.
    expect(provisionScript).not.toMatch(/\$\{EBAY_CLIENT_ID:-/);
    expect(provisionScript).not.toMatch(/\$\{EBAY_CLIENT_SECRET:-/);
  });

  it('validates eBay credentials before writing any secret', () => {
    const preflight = provisionScript.indexOf('assert_ebay_credentials_available');
    const firstWrite = provisionScript.indexOf('ensure_secret "${KEY_VAULT}"');

    expect(preflight).toBeGreaterThan(-1);
    // Aborting halfway through would leave one credential written and the other missing.
    expect(preflight).toBeLessThan(firstWrite);
  });

  it('refuses placeholder eBay credentials on a production target', () => {
    expect(commonScript).toContain('refusing to provision a production target without real eBay');
    // The opt-in escape hatch must be reachable only for non-production targets.
    const productionBranch = commonScript.indexOf('if [[ "${production}" == \'true\' ]]');
    const optIn = commonScript.indexOf('ALLOW_PLACEHOLDER_EBAY_CREDENTIALS');
    expect(productionBranch).toBeGreaterThan(-1);
    expect(productionBranch).toBeLessThan(optIn);
  });

  it('classifies a production eBay keyset as production regardless of the environment name', () => {
    expect(commonScript).toContain('targets_ebay_production');
    expect(commonScript).toContain('ebayEnvironment');
    // Anything unparseable must fail safe towards production.
    expect(commonScript).toContain('process.stdout.write("production")');
  });
});
