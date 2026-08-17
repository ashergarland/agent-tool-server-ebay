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

# Creates a Key Vault secret only when it does not already exist, so re-running provisioning never
# rotates credentials.
#
#   ensure_secret <vault> <name> <value>
#
# Returns 0 when it wrote a new value and 1 when one was already there. Any failure aborts the
# whole script: callers use this in an `if` condition, which suppresses `set -e` inside the
# function, and silently continuing would fail the app pass with the far more cryptic
# "Unable to get value using Managed identity ... for secret" that this ordering exists to avoid.
#
# The existence probe distinguishes "not found" from every other failure. Treating a throttled,
# unauthorised or transient read as "absent" would fall through to a write and silently rotate a
# live connector API key or eBay verification token — the exact outcome this function exists to
# prevent, and for the verification token one that also breaks eBay's periodic endpoint validation.
ensure_secret() {
  local vault="$1"
  local name="$2"
  local value="$3"
  local probe status

  set +e
  probe="$(az keyvault secret show --vault-name "${vault}" --name "${name}" --output none 2>&1)"
  status=$?
  set -e

  if [[ ${status} -eq 0 ]]; then
    echo "    ${name}: existing value left untouched."
    return 1
  fi
  if ! grep -qiE 'secretnotfound|was not found in this key vault|resourcenotfound' <<<"${probe}"; then
    echo "    ${name}: could not determine whether the secret exists; refusing to write." >&2
    echo "    ${probe}" >&2
    exit 1
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
