#!/usr/bin/env bash
#
# Builds the connector image in Azure Container Registry and redeploys the Container App
# pointing at the new tag.
#
# Usage:
#   ./scripts/bootstrap/deploy.sh <subscription-id> <environment> <location> <parameter-file>
#
# The fourth argument is required and is authoritative for persistent operator-owned desired state.
# Passing it on every deployment stops a release from silently resetting the eBay environment,
# marketplace, delivery context, log level, scaling or alerting settings back to Bicep defaults.
#
# Requires: az CLI (logged in), git.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: deploy.sh <subscription-id> <environment> <location> <parameter-file>}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westus2}"
PARAMETER_FILE_ARG="${4:-}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCE_GROUP="rg-chatgpt-ebay-${ENVIRONMENT}"
TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

# shellcheck source=scripts/bootstrap/common.sh
source "${REPO_ROOT}/scripts/bootstrap/common.sh"
resolve_parameter_files "${PARAMETER_FILE_ARG}"

echo "==> External deployment parameters ${PARAMETER_FILE}"
if [[ -n "${PARAMETER_OVERLAY}" ]]; then
  echo "==> Operator overlay ${PARAMETER_OVERLAY}"
fi

az account set --subscription "${SUBSCRIPTION_ID}"

REGISTRY_NAME="$(az acr list --resource-group "${RESOURCE_GROUP}" --query '[0].name' --output tsv)"
if [[ -z "${REGISTRY_NAME}" ]]; then
  echo "No container registry found in ${RESOURCE_GROUP}. Run provision.sh first." >&2
  exit 1
fi
REGISTRY_SERVER="$(az acr show --name "${REGISTRY_NAME}" --query loginServer --output tsv)"
# The legacy ACR repository is retained so existing revisions and rollback tags remain usable.
IMAGE="${REGISTRY_SERVER}/chatgpt-ebay:${TAG}"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"

APP_NAME="ca-chatgpt-ebay-${ENVIRONMENT}"
# provision.sh creates the app in its second pass, so it must already exist by the time we redeploy
# with a real image. Fail with an actionable message rather than a raw az ResourceNotFound.
FQDN="$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn --output tsv 2>/dev/null || true)"
if [[ -z "${FQDN}" ]]; then
  echo "Container app ${APP_NAME} not found in ${RESOURCE_GROUP}. Run provision.sh first." >&2
  exit 1
fi

KEY_VAULT="$(az keyvault list --resource-group "${RESOURCE_GROUP}" --query '[0].name' --output tsv)"
# The Container App mounts this secret by reference, so a missing one turns into an opaque
# "Unable to get value using Managed identity" revision failure. Fail early with the fix instead.
if [[ -z "${KEY_VAULT}" ]] || ! az keyvault secret show \
  --vault-name "${KEY_VAULT}" --name "${SECRET_ACCOUNT_DELETION_TOKEN}" --output none 2>/dev/null; then
  echo "Key Vault secret ${SECRET_ACCOUNT_DELETION_TOKEN} is missing from ${KEY_VAULT:-<no vault>}." >&2
  echo "Run ./scripts/bootstrap/provision.sh ${SUBSCRIPTION_ID} ${ENVIRONMENT} ${LOCATION} ${PARAMETER_FILE} to create it;" >&2
  echo "existing secrets are never rotated by provisioning." >&2
  exit 1
fi

CALLBACK_URL="https://${FQDN}${ACCOUNT_DELETION_PATH}"

echo "==> Building ${IMAGE} in ACR"
az acr build \
  --registry "${REGISTRY_NAME}" \
  --image "chatgpt-ebay:${TAG}" \
  --build-arg "GIT_SHA=${TAG}" \
  --build-arg "SERVICE_VERSION=${VERSION}" \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}" \
  --output none

echo "==> Redeploying ${APP_NAME} with the new image"
# Operator-owned parameters come first and release-specific values override them, so every
# persistent environment setting survives the deployment exactly as configured by the caller.
az deployment sub create \
  --name "chatgpt-ebay-${ENVIRONMENT}-$(date +%Y%m%d%H%M%S)" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  "${PARAMETER_ARGS[@]}" \
  --parameters environmentName="${ENVIRONMENT}" location="${LOCATION}" \
  --parameters "image=${IMAGE}" \
  --parameters "publicBaseUrl=https://${FQDN}" \
  --parameters "accountDeletionEndpointUrl=${CALLBACK_URL}" \
  --output none

echo "==> Deployed. Verifying health"
curl -fsS "https://${FQDN}/health" && echo

cat <<SUMMARY

==> Deployment complete

  Connector URL          https://${FQDN}
  Health                 https://${FQDN}/health
  Version                https://${FQDN}/version
  OpenAPI                https://${FQDN}/openapi.json
  MCP (Streamable HTTP)  https://${FQDN}/mcp
  eBay account deletion  ${CALLBACK_URL}
  Key Vault              ${KEY_VAULT}

Retrieve credentials only when you need them; neither value is printed automatically:
  az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_API_KEY} --query value -o tsv
  az keyvault secret show --vault-name ${KEY_VAULT} --name ${SECRET_ACCOUNT_DELETION_TOKEN} --query value -o tsv

SUMMARY
