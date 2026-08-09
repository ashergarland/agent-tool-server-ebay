# Deployment and operations

This guide covers the repository's Azure Container Apps deployment. Read the
[security considerations](../README.md#security-considerations) before using production
credentials.

## What gets deployed

The subscription-scoped Bicep template creates:

- a resource group;
- a user-assigned managed identity;
- an Azure Container Registry;
- a Key Vault containing the connector API key and eBay application credentials;
- a Log Analytics workspace and Container Apps environment;
- a Container App with external HTTPS ingress; and
- optional availability monitoring and alerts.

The managed identity can pull from its registry and read secrets from its vault. It receives no
subscription-wide data-plane role because the connector communicates with eBay, not Azure APIs.

## Prerequisites

Install the following locally:

- Azure CLI, authenticated with `az login`;
- Git;
- Node.js 22 or newer; and
- OpenSSL.

The deploying principal must be able to create subscription deployments, resource groups, role
assignments, and the resources listed above. It must also be able to grant itself Key Vault
data-plane access. Confirm the target before proceeding:

```bash
az account show --query '{name:name, subscription:id, tenant:tenantId}' -o table
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights
```

Obtain an eBay App ID and Cert ID from
[Application Keysets](https://developer.ebay.com/my/keys). Use sandbox credentials with
`EBAY_ENVIRONMENT=sandbox`; production Browse API access requires eBay approval.

## First deployment

From the repository root:

```bash
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... \
  ./scripts/bootstrap/provision.sh <subscription-id> [environment] [location]
./scripts/bootstrap/deploy.sh <subscription-id> [environment] [location]
```

The optional environment and location default to `prod` and `westus2`. Environment names must be
2–10 characters and should contain only characters accepted by the generated Azure resource names.

Provisioning intentionally happens in two passes. The first pass creates the identity, registry,
vault, logs, and role assignments. The script grants the current user `Key Vault Secrets Officer`,
waits for propagation, and stores a generated connector API key plus the supplied eBay credentials.
The second pass creates the Container App, which reads those values directly from Key Vault.

If eBay credentials are omitted, the script writes conspicuous placeholders and prints commands for
replacing them. Replace both before expecting eBay tool calls to succeed.

The initial app uses a placeholder image. `deploy.sh` builds the current commit in ACR, updates the
Container App, sets its public URL, and verifies `/health`. Do not register the connector before
this step: until the real hostname is supplied, the generated OpenAPI document advertises
localhost.

## Verify the deployment

Discover the endpoint from the environment name:

```bash
RESOURCE_GROUP="rg-chatgpt-ebay-prod"
APP_NAME="ca-chatgpt-ebay-prod"
FQDN="$(az containerapp show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --query properties.configuration.ingress.fqdn -o tsv)"

curl -fsS "https://$FQDN/health"
curl -fsS "https://$FQDN/version"
curl -fsS "https://$FQDN/openapi.json"
```

Retrieve the connector key without printing it into shared logs:

```bash
KEY_VAULT="$(az keyvault list \
  --resource-group "$RESOURCE_GROUP" \
  --query '[0].name' -o tsv)"
API_KEY="$(az keyvault secret show \
  --vault-name "$KEY_VAULT" \
  --name connector-api-key \
  --query value -o tsv)"
curl -fsS -H "x-api-key: $API_KEY" "https://$FQDN/tools"
unset API_KEY
```

Before registration, verify that:

- the OpenAPI `servers` URL uses the public HTTPS hostname;
- `/tools` rejects requests without authentication;
- `/version` reports the expected commit and eBay environment;
- the configured marketplace and buyer location are appropriate; and
- application logs reach the intended workspace.

## Configure eBay behavior

The Bicep template accepts `ebayEnvironment`, `ebayMarketplaceId`, `ebayDeliveryCountry`, and
`ebayDeliveryPostalCode`. Preview changes before applying them:

```bash
az deployment sub what-if \
  --location westus2 \
  --template-file infra/main.bicep \
  --parameters \
    environmentName=prod \
    ebayEnvironment=sandbox \
    ebayMarketplaceId=EBAY_US \
    ebayDeliveryCountry=US \
    ebayDeliveryPostalCode=19406
```

Buyer country and postal code improve calculated-shipping and delivered-total coverage. They are
omitted from the container environment when empty. The connector remains read-only in every
configuration: it calls only eBay Browse API `GET` endpoints.

## Updates and rollback

`deploy.sh` tags images with the current Git commit, builds them in ACR, and redeploys the app:

```bash
git checkout <reviewed-commit>
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2
```

To roll back, check out a previously reviewed commit and run the same command. Each deployment
performs a health check after the update. Confirm `/version` reports the expected commit before
closing an incident.

## Rotate credentials

Generate and store a new connector key:

```bash
NEW_API_KEY="$(openssl rand -hex 32)"
az keyvault secret set \
  --vault-name "$KEY_VAULT" \
  --name connector-api-key \
  --value "$NEW_API_KEY" \
  --output none
unset NEW_API_KEY
```

Set new eBay credentials in the `ebay-client-id` and `ebay-client-secret` secrets. Create a new
Container App revision or restart the active revision so Key Vault-backed values are re-read. Update
the credential configured in ChatGPT after rotating the connector key, and verify that the old key
is rejected.

Avoid passing secrets in command history, CI output, issue reports, or screenshots.

## Monitoring and logs

Tail structured container logs during an investigation:

```bash
az containerapp logs show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --follow
```

The Bicep template can create an availability test and action group. Set
`enableHealthAlerts=true` and provide `alertEmails` or `alertSmsPhone` at deployment time. Do not
commit personal contact details to a parameter file.

Monitor at least:

- `/health` availability and latency;
- HTTP 401, 429, and 5xx rates;
- eBay OAuth failures, timeouts, and throttling;
- Container App restarts and failed revisions; and
- Log Analytics ingestion against its daily cap.

## Troubleshooting

### Key Vault rejects a secret write

The bootstrap script grants `Key Vault Secrets Officer`, but RBAC propagation can take longer than
its initial wait. Confirm the assignment exists at vault scope, wait, and rerun `provision.sh`.
Existing secrets are preserved.

### The image cannot be pulled

Confirm the managed identity has `AcrPull` on the generated registry and that the image tag exists.
Inspect the failed Container App revision and ACR build logs.

### OpenAPI advertises localhost

Run `deploy.sh`. It reads the Container App hostname and redeploys with `PUBLIC_BASE_URL`. An empty
URL is invalid configuration and should not be passed explicitly.

### eBay returns 401 or 403

Confirm the App ID and Cert ID belong to the environment selected by `EBAY_ENVIRONMENT`. A
production keyset may not have Browse API access; use the sandbox until eBay approves production
access.

### Listings lack shipping totals

Set both `ebayDeliveryCountry` and `ebayDeliveryPostalCode`. Calculated-shipping listings often omit
shipping options without a buyer location.

### The service returns 429 or 504

429 means the connector or eBay rate limit was reached. 504 means `REQUEST_TIMEOUT_MS` elapsed.
Reduce request volume, retry with backoff, and inspect logs before raising limits or timeouts.

## Remove an environment

Export any required logs first. Deleting the generated resource group removes the app, registry,
vault, and workspace:

```bash
az group delete --name rg-chatgpt-ebay-prod
```

Remove the connector registration from ChatGPT and revoke any copied connector or eBay credentials.
