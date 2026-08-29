#!/usr/bin/env bash
#
# Provisions agent-tool-server-ebay while retaining existing chatgpt-ebay Azure deployment names,
# stores a freshly generated connector API key and eBay marketplace account deletion verification
# token in Key Vault, and seeds the eBay credentials.
#
# Usage:
#   ./scripts/bootstrap/provision.sh <subscription-id> [environment] [location] [parameter-file]
#
# The parameter file defaults to the portable baseline at
# infra/parameters/<environment>.parameters.json. An external file supplied as argument 4 replaces
# that baseline and is the authoritative operator configuration; see common.sh for precedence.
#
# Export EBAY_CLIENT_ID and EBAY_CLIENT_SECRET beforehand. They are required whenever the vault
# does not already hold them and the target is eBay production; placeholder credentials are never
# written to a production vault. Use a prompt rather than the command line so the values do not
# enter your shell history:
#
#   read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID
#   read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET
#
# Requires: az CLI (logged in), openssl, node.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: provision.sh <subscription-id> [environment] [location] [parameter-file]}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westus2}"
PARAMETER_FILE_ARG="${4:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAMP="$(date +%Y%m%d%H%M%S)"

# shellcheck source=scripts/bootstrap/common.sh
source "${REPO_ROOT}/scripts/bootstrap/common.sh"
resolve_parameter_files "${REPO_ROOT}" "${ENVIRONMENT}" "${PARAMETER_FILE_ARG}"

echo "==> Using subscription ${SUBSCRIPTION_ID}"
echo "==> Environment configuration ${PARAMETER_FILE}"
if [[ -n "${PARAMETER_OVERLAY}" ]]; then
  echo "==> Operator overlay ${PARAMETER_OVERLAY}"
fi
az account set --subscription "${SUBSCRIPTION_ID}"

# The Container App mounts the connector API key, both eBay credentials and the account deletion
# verification token straight out of Key Vault, so it cannot be created until those secrets exist.
# Pass 1 stands up the vault and the identity, we write the secrets, and pass 2 brings the app up.
FOUNDATION_DEPLOYMENT="chatgpt-ebay-${ENVIRONMENT}-foundation-${STAMP}"
echo "==> Deploying foundation: identity, registry, vault, logs (${FOUNDATION_DEPLOYMENT})"
az deployment sub create \
  --name "${FOUNDATION_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  "${PARAMETER_ARGS[@]}" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" deployApp=false \
  --output none

RESOURCE_GROUP="$(deployment_output "${FOUNDATION_DEPLOYMENT}" resourceGroupName)"
KEY_VAULT="$(deployment_output "${FOUNDATION_DEPLOYMENT}" keyVaultName)"
REGISTRY="$(deployment_output "${FOUNDATION_DEPLOYMENT}" registryLoginServer)"
IDENTITY_CLIENT_ID="$(deployment_output "${FOUNDATION_DEPLOYMENT}" identityClientId)"

# The vault uses RBAC authorisation, so subscription Owner alone does not grant data-plane
# access. Grant the operator the secrets role and wait for it to propagate.
CALLER_ID="$(az ad signed-in-user show --query id --output tsv)"
VAULT_ID="$(az keyvault show --name "${KEY_VAULT}" --resource-group "${RESOURCE_GROUP}" --query id --output tsv)"
if ! az role assignment list --assignee "${CALLER_ID}" --scope "${VAULT_ID}" \
  --query "[?roleDefinitionName=='Key Vault Secrets Officer'] | [0]" --output tsv | grep -q .; then
  echo "==> Granting the current user Key Vault Secrets Officer on ${KEY_VAULT}"
  az role assignment create \
    --assignee-object-id "${CALLER_ID}" \
    --assignee-principal-type User \
    --role "Key Vault Secrets Officer" \
    --scope "${VAULT_ID}" \
    --output none
  echo "    Waiting for the role assignment to propagate"
  sleep 45
fi

# Creates a secret only when it does not already exist, so re-running never rotates credentials.
# The implementation lives in common.sh so it can be exercised by
# scripts/verify-parameter-resolution.sh without touching Azure.
#
# The eBay credentials are checked *before* anything is written. Provisioning used to fall back to
# `REPLACE_WITH_EBAY_APP_ID` / `REPLACE_WITH_EBAY_CERT_ID` when the environment variables were
# absent, and because existing secrets are deliberately never overwritten, that placeholder then
# survived every later run.
if targets_ebay_production "${ENVIRONMENT}" "${PARAMETER_FILE}" "${PARAMETER_OVERLAY}"; then
  EBAY_TARGET_IS_PRODUCTION='true'
else
  EBAY_TARGET_IS_PRODUCTION='false'
fi

echo "==> Checking eBay application credentials (production target: ${EBAY_TARGET_IS_PRODUCTION})"
assert_ebay_credentials_available "${KEY_VAULT}" "${EBAY_TARGET_IS_PRODUCTION}"

echo "==> Seeding secrets in ${KEY_VAULT}"
if ensure_secret "${KEY_VAULT}" "${SECRET_API_KEY}" "$(openssl rand -hex 32)"; then
  echo "    Retrieve the generated connector API key with:"
  echo "    az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_API_KEY} --query value -o tsv"
fi
ensure_ebay_credential "${KEY_VAULT}" "${SECRET_EBAY_CLIENT_ID}" 'EBAY_CLIENT_ID' 'REPLACE_WITH_EBAY_APP_ID'
ensure_ebay_credential "${KEY_VAULT}" "${SECRET_EBAY_CLIENT_SECRET}" 'EBAY_CLIENT_SECRET' 'REPLACE_WITH_EBAY_CERT_ID'
# 48 hexadecimal characters sits inside eBay's documented 32-80 character limit and uses only
# characters from its allowed alphanumeric/underscore/hyphen set. It is generated rather than
# supplied so no operator ever has to invent, paste or store one outside Key Vault.
if ensure_secret "${KEY_VAULT}" "${SECRET_ACCOUNT_DELETION_TOKEN}" "$(openssl rand -hex 24)"; then
  echo "    Retrieve the generated verification token when registering with eBay:"
  echo "    az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_ACCOUNT_DELETION_TOKEN} --query value -o tsv"
fi

APP_NAME="ca-chatgpt-ebay-${ENVIRONMENT}"

# Re-provisioning an environment must not roll the running image back to the placeholder, so the
# currently deployed image is reused when the app already exists.
EXISTING_IMAGE="$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --query "properties.template.containers[0].image" --output tsv 2>/dev/null || true)"
IMAGE_ARGS=()
if [[ -n "${EXISTING_IMAGE}" ]]; then
  echo "==> Reusing the image already deployed to ${APP_NAME}"
  IMAGE_ARGS=(--parameters "image=${EXISTING_IMAGE}")
fi
# Expanded through `${a[@]+...}` below because on bash 3.2 — still the default /bin/bash on
# macOS — expanding an empty array under `set -u` aborts the script with "unbound variable".

# The app's ingress hostname is derived from the managed environment domain, which only exists
# after the app deployment. Deploy once to create it, then read the FQDN back and deploy again so
# PUBLIC_BASE_URL and the account deletion callback URL are correct from the very first bootstrap.
APP_DEPLOYMENT="chatgpt-ebay-${ENVIRONMENT}-app-${STAMP}"
echo "==> Deploying the Container App (${APP_DEPLOYMENT})"
az deployment sub create \
  --name "${APP_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  "${PARAMETER_ARGS[@]}" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  ${IMAGE_ARGS[@]+"${IMAGE_ARGS[@]}"} \
  --output none

CONNECTOR_URL="$(deployment_output "${APP_DEPLOYMENT}" connectorUrl)"
CALLBACK_URL="$(deployment_output "${APP_DEPLOYMENT}" accountDeletionCallbackUrl)"

FINALIZE_DEPLOYMENT="chatgpt-ebay-${ENVIRONMENT}-urls-${STAMP}"
echo "==> Applying the public URLs now that ingress exists (${FINALIZE_DEPLOYMENT})"
az deployment sub create \
  --name "${FINALIZE_DEPLOYMENT}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  "${PARAMETER_ARGS[@]}" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  --parameters "publicBaseUrl=${CONNECTOR_URL}" \
  --parameters "accountDeletionEndpointUrl=${CALLBACK_URL}" \
  ${IMAGE_ARGS[@]+"${IMAGE_ARGS[@]}"} \
  --output none

if [[ -z "${EXISTING_IMAGE}" ]]; then
  PLACEHOLDER_NOTE='The app is currently running the placeholder image.'
else
  PLACEHOLDER_NOTE="The app is running ${EXISTING_IMAGE}."
fi

cat <<SUMMARY

==> Bootstrap complete

  Resource group        ${RESOURCE_GROUP}
  Container registry    ${REGISTRY}
  Key Vault             ${KEY_VAULT}
  Identity client id    ${IDENTITY_CLIENT_ID}
  Connector URL         ${CONNECTOR_URL}
  Account deletion URL  ${CALLBACK_URL}

${PLACEHOLDER_NOTE}

Retrieve secrets only when you need them, and do not paste them into shared logs:
  az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_API_KEY} --query value -o tsv
  az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_ACCOUNT_DELETION_TOKEN} --query value -o tsv

Next steps:
  1. Build and push the real image:
       ./scripts/bootstrap/deploy.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION} ${PARAMETER_FILE}
  2. Register the account deletion callback in the eBay developer portal under
     Application Keys -> Production keyset -> Alerts & Notifications, using
       ${CALLBACK_URL}
     and the verification token above. See docs/deployment.md for the full runbook.
  3. Register the connector in ChatGPT using ${CONNECTOR_URL}/openapi.json
     with the API key from Key Vault as the bearer token.

SUMMARY
