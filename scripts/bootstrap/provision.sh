#!/usr/bin/env bash
#
# Provisions the chatgpt-ebay connector infrastructure, stores a freshly generated connector API
# key in Key Vault, and seeds placeholders for the eBay application credentials.
#
# Usage:
#   ./scripts/bootstrap/provision.sh <subscription-id> [environment] [location]
#
# Optionally export EBAY_CLIENT_ID and EBAY_CLIENT_SECRET beforehand and this script will store
# the real values instead of placeholders.
#
# Requires: az CLI (logged in), openssl.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: provision.sh <subscription-id> [environment] [location]}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westeurope}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOYMENT_NAME="chatgpt-ebay-${ENVIRONMENT}-$(date +%Y%m%d%H%M%S)"

echo "==> Using subscription ${SUBSCRIPTION_ID}"
az account set --subscription "${SUBSCRIPTION_ID}"

echo "==> Deploying infrastructure (${DEPLOYMENT_NAME})"
az deployment sub create \
  --name "${DEPLOYMENT_NAME}" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  --output none

read_output() {
  az deployment sub show --name "${DEPLOYMENT_NAME}" \
    --query "properties.outputs.$1.value" --output tsv
}

RESOURCE_GROUP="$(read_output resourceGroupName)"
KEY_VAULT="$(read_output keyVaultName)"
REGISTRY="$(read_output registryLoginServer)"
IDENTITY_CLIENT_ID="$(read_output identityClientId)"
CONNECTOR_URL="$(read_output connectorUrl)"

# Creates a secret only when it does not already exist, so re-running never rotates credentials.
ensure_secret() {
  local name="$1"
  local value="$2"
  if az keyvault secret show --vault-name "${KEY_VAULT}" --name "${name}" --output none 2>/dev/null; then
    echo "    ${name}: existing value left untouched."
    return 1
  fi
  az keyvault secret set \
    --vault-name "${KEY_VAULT}" \
    --name "${name}" \
    --value "${value}" \
    --output none
  echo "    ${name}: created."
  return 0
}

echo "==> Seeding secrets in ${KEY_VAULT}"
if ensure_secret connector-api-key "$(openssl rand -hex 32)"; then
  echo "    Retrieve the generated connector API key with:"
  echo "    az keyvault secret show --vault-name ${KEY_VAULT} --name connector-api-key --query value -o tsv"
fi
ensure_secret ebay-client-id "${EBAY_CLIENT_ID:-REPLACE_WITH_EBAY_APP_ID}" || true
ensure_secret ebay-client-secret "${EBAY_CLIENT_SECRET:-REPLACE_WITH_EBAY_CERT_ID}" || true

cat <<SUMMARY

==> Bootstrap complete

  Resource group        ${RESOURCE_GROUP}
  Container registry    ${REGISTRY}
  Key Vault             ${KEY_VAULT}
  Identity client id    ${IDENTITY_CLIENT_ID}
  Connector URL         ${CONNECTOR_URL}

Next steps:
  1. Store your real eBay application credentials (skip if you exported them above):
       az keyvault secret set --vault-name ${KEY_VAULT} --name ebay-client-id --value '<App ID>'
       az keyvault secret set --vault-name ${KEY_VAULT} --name ebay-client-secret --value '<Cert ID>'
  2. Build and push the image:
       ./scripts/bootstrap/deploy.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION}
  3. Register the connector in ChatGPT using ${CONNECTOR_URL}/openapi.json
     with the API key from Key Vault as the bearer token.

SUMMARY
