#!/usr/bin/env bash
#
# Shared deployment plumbing for provision.sh and deploy.sh.
#
# Both scripts deploy the *same* template with the *same* canonical environment configuration, so
# that a redeploy can never silently reapply a Bicep default for a setting an operator configured.
#
# Parameter precedence, lowest to highest:
#   1. defaults declared in infra/main.bicep
#   2. infra/parameters/<environment>.parameters.json      (committed, canonical, required)
#   3. infra/parameters/<environment>.local.parameters.json (gitignored, optional overlay for
#      account-specific values such as alert recipients)
#   4. release-specific values passed on the command line: image, publicBaseUrl,
#      accountDeletionEndpointUrl, deployApp
#
# Sourced, never executed directly.

# Key Vault secret names. Kept here so both scripts agree with infra/main.bicep.
SECRET_API_KEY='connector-api-key'
SECRET_EBAY_CLIENT_ID='ebay-client-id'
SECRET_EBAY_CLIENT_SECRET='ebay-client-secret'
SECRET_ACCOUNT_DELETION_TOKEN='ebay-account-deletion-token'

# Path of the public eBay Marketplace Account Deletion callback. Must match
# ACCOUNT_DELETION_ROUTE_PATH in src/compliance/ebay-account-deletion/routes.ts and the
# accountDeletionCallbackUrl output in infra/main.bicep.
ACCOUNT_DELETION_PATH='/ebay/notifications/marketplace-account-deletion'

# Resolves the canonical parameter file and its optional operator overlay for an environment.
# Populates the PARAMETER_ARGS array with the --parameters arguments to pass to az.
resolve_parameter_files() {
  local repo_root="$1"
  local environment="$2"
  local explicit="${3:-}"

  local base="${explicit:-${repo_root}/infra/parameters/${environment}.parameters.json}"
  if [[ ! -f "${base}" ]]; then
    echo "Parameter file not found: ${base}" >&2
    echo "Every deployment must supply one so environment settings are never reset to Bicep defaults." >&2
    exit 1
  fi

  PARAMETER_ARGS=(--parameters "@${base}")
  PARAMETER_FILE="${base}"

  local overlay="${base%.parameters.json}.local.parameters.json"
  if [[ -f "${overlay}" ]]; then
    PARAMETER_ARGS+=(--parameters "@${overlay}")
    PARAMETER_OVERLAY="${overlay}"
  else
    PARAMETER_OVERLAY=''
  fi
}

# Reads a named output from a completed subscription deployment.
deployment_output() {
  az deployment sub show --name "$1" --query "properties.outputs.$2.value" --output tsv
}

# Reports whether a Key Vault secret exists.
#
#   secret_exists <vault> <name>   -> 0 present, 1 definitively absent
#
# Any *ambiguous* failure aborts the script rather than being reported as absence. A read can fail
# for reasons that have nothing to do with the secret being missing — throttling, a transient 5xx,
# or missing data-plane RBAC — and treating those as "absent" would let a caller fall through to a
# write and silently rotate a live credential.
secret_exists() {
  local vault="$1"
  local name="$2"
  local probe status

  set +e
  probe="$(az keyvault secret show --vault-name "${vault}" --name "${name}" --output none 2>&1)"
  status=$?
  set -e

  if [[ ${status} -eq 0 ]]; then
    return 0
  fi
  if ! grep -qiE 'secretnotfound|was not found in this key vault|resourcenotfound' <<<"${probe}"; then
    echo "    ${name}: could not determine whether the secret exists; refusing to write." >&2
    echo "    ${probe}" >&2
    exit 1
  fi
  return 1
}

# Creates a Key Vault secret only when it does not already exist, so re-running provisioning never
# rotates credentials.
#
#   ensure_secret <vault> <name> <value>
#
# Returns 0 when it wrote a new value and 1 when one was already there. Any failure aborts the
# whole script: callers use this in an `if` condition, which suppresses `set -e` inside the
# function, and silently continuing would fail the app pass with the far more cryptic
# "Unable to get value using Managed identity ... for secret" that this ordering exists to avoid.
ensure_secret() {
  local vault="$1"
  local name="$2"
  local value="$3"

  if secret_exists "${vault}" "${name}"; then
    echo "    ${name}: existing value left untouched."
    return 1
  fi

  if ! az keyvault secret set \
    --vault-name "${vault}" \
    --name "${name}" \
    --value "${value}" \
    --output none; then
    echo "    ${name}: FAILED to write." >&2
    echo "    Check that you hold Key Vault Secrets Officer on ${vault}; the vault uses RBAC" >&2
    echo "    authorisation, under which subscription Owner alone grants no data-plane access." >&2
    exit 1
  fi
  echo "    ${name}: created."
  return 0
}

# The eBay application credentials, paired with the environment variables that supply them.
EBAY_CREDENTIAL_SECRETS=("${SECRET_EBAY_CLIENT_ID}" "${SECRET_EBAY_CLIENT_SECRET}")
EBAY_CREDENTIAL_ENV_VARS=('EBAY_CLIENT_ID' 'EBAY_CLIENT_SECRET')
EBAY_CREDENTIAL_LABELS=('App ID' 'Cert ID')

# Reports whether this deployment targets the eBay *production* keyset, and therefore must never
# hold placeholder credentials.
#
#   targets_ebay_production <environment> <parameter-file>...
#
# Every parameter file that contributes to the deployment must be passed, base and operator
# overlay alike: `resolve_parameter_files` layers the overlay last and Azure honours the final
# `--parameters`, so an overlay can flip a sandbox base to the production keyset. Considering only
# the base file would let that deployment be classified non-production and become eligible for
# placeholder credentials.
#
# The environment name is consulted too, so an environment named something other than "prod" cannot
# quietly opt out while still pointing at the production keyset. Production in *any* input wins:
# the cost of being wrong in that direction is having to supply real credentials for a sandbox,
# against an unrecoverable production vault full of placeholders in the other. Anything unparseable
# is likewise treated as production, matching the Bicep default.
targets_ebay_production() {
  local environment="$1"
  shift
  local parameter_file declared
  local examined=0

  # Lower-cased so an environment spelled "PROD" or "Production" cannot slip past the name check.
  case "$(printf '%s' "${environment}" | tr '[:upper:]' '[:lower:]')" in
    prod | prod-* | prd | production | production-*) return 0 ;;
  esac

  for parameter_file in "$@"; do
    [[ -n "${parameter_file}" ]] || continue
    examined=1
    [[ -f "${parameter_file}" ]] || return 0

    declared="$(node -e '
      const { readFileSync } = require("node:fs");
      try {
        const parsed = JSON.parse(readFileSync(process.argv[1], "utf8"));
        process.stdout.write(String(parsed?.parameters?.ebayEnvironment?.value ?? ""));
      } catch {
        process.stdout.write("production");
      }
    ' "${parameter_file}" 2>/dev/null)" || declared='production'

    # An unset value means the Bicep default applies, which is production.
    [[ "${declared}" == 'sandbox' ]] || return 0
  done

  # Nothing usable was supplied. Unreachable from provision.sh, which always passes a resolved
  # parameter file, but a caller that learns nothing must not conclude "sandbox".
  ((examined == 1)) || return 0

  return 1
}

# Verifies, *before any secret is written*, that every eBay application credential either already
# exists in the vault or has been supplied in the environment.
#
#   assert_ebay_credentials_available <vault> <production true|false>
#
# Provisioning used to write `REPLACE_WITH_EBAY_APP_ID` / `REPLACE_WITH_EBAY_CERT_ID` whenever the
# environment variables were absent. Because `ensure_secret` correctly refuses to overwrite an
# existing secret, that placeholder then survived every later provisioning run: the deployment kept
# failing eBay authentication with a value nothing in the system could tell was fake, and the only
# repair was a manual `az keyvault secret set`. Placeholders are therefore never written to a
# production target, and outside production they require an explicit opt-in.
#
# Running as a single pre-flight pass matters: aborting halfway through would leave one credential
# written and the other missing.
assert_ebay_credentials_available() {
  local vault="$1"
  local production="$2"
  local index name env_var label supplied
  local missing=()

  for index in "${!EBAY_CREDENTIAL_SECRETS[@]}"; do
    name="${EBAY_CREDENTIAL_SECRETS[${index}]}"
    env_var="${EBAY_CREDENTIAL_ENV_VARS[${index}]}"
    label="${EBAY_CREDENTIAL_LABELS[${index}]}"
    supplied="${!env_var:-}"

    # An existing secret is authoritative: the environment variable is not needed, and the stored
    # value is never rotated.
    if secret_exists "${vault}" "${name}"; then
      echo "    ${name}: already present in ${vault}."
      continue
    fi
    if [[ -z "${supplied}" ]]; then
      missing+=("${name} (${label}) is absent from ${vault} and ${env_var} is not set")
    fi
  done

  ((${#missing[@]} > 0)) || return 0

  if [[ "${production}" == 'true' ]]; then
    {
      echo
      echo "ERROR: refusing to provision a production target without real eBay credentials."
      for entry in "${missing[@]}"; do
        echo "  - ${entry}"
      done
      echo
      echo "Placeholder credentials are never written to a production vault. A placeholder cannot"
      echo "later be corrected by re-running this script, because existing secrets are deliberately"
      echo "left untouched, so it would silently break every eBay call until someone found it."
      echo
      echo "Supply the production keyset and re-run. Use a prompt rather than the command line so"
      echo "the values do not enter your shell history:"
      echo "    read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID"
      echo "    read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET"
      echo
      echo "Obtain them from https://developer.ebay.com/my/keys (production keyset)."
      echo
    } >&2
    exit 1
  fi

  if [[ "${ALLOW_PLACEHOLDER_EBAY_CREDENTIALS:-}" != '1' ]]; then
    {
      echo
      echo "ERROR: eBay credentials are missing for this non-production target."
      for entry in "${missing[@]}"; do
        echo "  - ${entry}"
      done
      echo
      echo "Supply real sandbox credentials:"
      echo "    read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID"
      echo "    read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET"
      echo
      echo "Or, if you only need the infrastructure to stand up and accept that every eBay call"
      echo "will fail until you replace them by hand, opt in explicitly:"
      echo "    ALLOW_PLACEHOLDER_EBAY_CREDENTIALS=1"
      echo
    } >&2
    exit 1
  fi

  echo "    WARNING: writing placeholder eBay credentials for this non-production target." >&2
  echo "    Every eBay call will fail until they are replaced with:" >&2
  echo "        az keyvault secret set --vault-name ${vault} --name ${SECRET_EBAY_CLIENT_ID} --value '<App ID>'" >&2
  echo "        az keyvault secret set --vault-name ${vault} --name ${SECRET_EBAY_CLIENT_SECRET} --value '<Cert ID>'" >&2
}

# Seeds one eBay application credential. The pre-flight above has already established that this is
# permitted, so reaching a placeholder here is a deliberate, opted-in non-production choice.
#
#   ensure_ebay_credential <vault> <name> <env-var> <placeholder>
ensure_ebay_credential() {
  local vault="$1"
  local name="$2"
  local env_var="$3"
  local placeholder="$4"
  local supplied="${!env_var:-}"

  ensure_secret "${vault}" "${name}" "${supplied:-${placeholder}}" || true
}
