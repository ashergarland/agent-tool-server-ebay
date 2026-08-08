#!/usr/bin/env bash
#
# Builds the connector image in Azure Container Registry and redeploys the Container App
# pointing at the new tag.
#
# Usage:
#   ./scripts/bootstrap/deploy.sh <subscription-id> [environment] [location]
#
# Requires: az CLI (logged in), git.

set -euo pipefail

SUBSCRIPTION_ID="${1:?usage: deploy.sh <subscription-id> [environment] [location]}"
ENVIRONMENT="${2:-prod}"
LOCATION="${3:-westus2}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RESOURCE_GROUP="rg-chatgpt-ebay-${ENVIRONMENT}"
TAG="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"

az account set --subscription "${SUBSCRIPTION_ID}"

REGISTRY_NAME="$(az acr list --resource-group "${RESOURCE_GROUP}" --query '[0].name' --output tsv)"
if [[ -z "${REGISTRY_NAME}" ]]; then
  echo "No container registry found in ${RESOURCE_GROUP}. Run provision.sh first." >&2
  exit 1
fi
REGISTRY_SERVER="$(az acr show --name "${REGISTRY_NAME}" --query loginServer --output tsv)"
IMAGE="${REGISTRY_SERVER}/chatgpt-ebay:${TAG}"
VERSION="$(node -p "require('${REPO_ROOT}/package.json').version")"

echo "==> Building ${IMAGE} in ACR"
az acr build \
  --registry "${REGISTRY_NAME}" \
  --image "chatgpt-ebay:${TAG}" \
  --build-arg "GIT_SHA=${TAG}" \
  --build-arg "SERVICE_VERSION=${VERSION}" \
  --file "${REPO_ROOT}/Dockerfile" \
  "${REPO_ROOT}" \
  --output none

APP_NAME="ca-chatgpt-ebay-${ENVIRONMENT}"
# provision.sh creates the app in its second pass, so it must already exist by the time we redeploy
# with a real image. Fail with an actionable message rather than a raw az ResourceNotFound.
FQDN="$(az containerapp show --name "${APP_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --query properties.configuration.ingress.fqdn --output tsv 2>/dev/null || true)"
if [[ -z "${FQDN}" ]]; then
  echo "Container app ${APP_NAME} not found in ${RESOURCE_GROUP}. Run provision.sh first." >&2
  exit 1
fi

echo "==> Redeploying ${APP_NAME} with the new image"
az deployment sub create \
  --name "chatgpt-ebay-${ENVIRONMENT}-$(date +%Y%m%d%H%M%S)" \
  --location "${LOCATION}" \
  --template-file "${REPO_ROOT}/infra/main.bicep" \
  --parameters \
    environmentName="${ENVIRONMENT}" \
    location="${LOCATION}" \
    image="${IMAGE}" \
    publicBaseUrl="https://${FQDN}" \
  --output none

echo "==> Deployed. Verifying health"
curl -fsS "https://${FQDN}/health" && echo
echo "OpenAPI: https://${FQDN}/openapi.json"
