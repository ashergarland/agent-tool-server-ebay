# Deployment and operations

This guide covers the repository's Azure Container Apps deployment. Read the
[authentication and security](../README.md#authentication-and-security) before using production
credentials.

The repository is now `agent-tool-server-ebay`, but existing Azure resource and private image
names retain the earlier `chatgpt-ebay` identifier. This is intentional compatibility behavior,
not stale public branding; see [Legacy deployment compatibility](#legacy-deployment-compatibility).

## What gets deployed

The subscription-scoped Bicep template creates:

- a resource group;
- a user-assigned managed identity;
- an Azure Container Registry;
- a Key Vault containing the connector API key, the eBay application credentials, and the eBay
  marketplace account deletion verification token;
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

A production keyset also requires Marketplace Account Deletion/Closure compliance — either a
registered notification endpoint or an eBay-granted exemption — before it is enabled. This
repository implements the endpoint; see
[Post-merge production activation runbook](#post-merge-production-activation-runbook).

## First deployment

From the repository root:

```bash
read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID
read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET

./scripts/bootstrap/provision.sh <subscription-id> prod westus2 infra/parameters/prod.parameters.json
./scripts/bootstrap/deploy.sh    <subscription-id> prod westus2 infra/parameters/prod.parameters.json
```

The optional environment, location, and parameter file default to `prod`, `westus2`, and
`infra/parameters/<environment>.parameters.json`. Environment names must be 2–10 characters and
should contain only characters accepted by the generated Azure resource names.

The committed files are portable, account-neutral baselines for development or simple standalone
deployments. An operator can instead make an external ARM parameter file authoritative:

```bash
./scripts/bootstrap/deploy.sh \
  <subscription-id> \
  prod \
  westus2 \
  /path/to/operator/prod.parameters.json
```

The external file replaces the committed baseline; it is not layered on top of it.

Provisioning intentionally happens in multiple passes. The first pass creates the identity, registry,
vault, logs, and role assignments. The script grants the current user `Key Vault Secrets Officer`,
waits for propagation, and stores a generated connector API key, a generated eBay account-deletion
verification token, and the supplied eBay credentials. The second pass creates the Container App,
which reads those values directly from Key Vault. A third pass applies `PUBLIC_BASE_URL` and the
account-deletion callback URL, neither of which can be known until ingress exists.

### eBay credentials are required, never placeheld

`EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` are required whenever the vault does not already hold
them and the deployment targets the eBay **production** keyset. Provisioning validates this up
front and aborts before writing anything, so a run can never half-complete.

Earlier revisions wrote `REPLACE_WITH_EBAY_APP_ID` / `REPLACE_WITH_EBAY_CERT_ID` when the variables
were absent. That was a trap: because an existing secret is deliberately never overwritten, the
placeholder survived every later provisioning run, and every eBay call failed against a value
nothing in the system could tell was fake. Placeholders are therefore never written to a production
vault, under any combination of flags.

A target counts as production when the environment is named `prod`-like **or** any parameter file
that contributes to the deployment declares `ebayEnvironment: production` — the selected base file
and an operator overlay alike, since the overlay is layered last and wins at deploy time. All signals
are consulted so an environment named something else, or a sandbox base that an overlay flips to
the production keyset, cannot quietly opt out. An unreadable or malformed parameter file is treated
as production, which is the direction that fails safe.

Behaviour in full:

| Vault state    | Target         | Environment variables | Result                                                   |
| -------------- | -------------- | --------------------- | -------------------------------------------------------- |
| Secret exists  | any            | not needed            | Left untouched; never rotated                            |
| Secret missing | production     | supplied              | Written once                                             |
| Secret missing | production     | absent                | **Aborts** before any write, with the commands to fix it |
| Secret missing | non-production | supplied              | Written once                                             |
| Secret missing | non-production | absent                | Aborts unless `ALLOW_PLACEHOLDER_EBAY_CREDENTIALS=1`     |

The non-production opt-in exists only to let sandbox and throwaway environments stand the
infrastructure up before credentials are available. It is refused outright on a production target,
and it warns that every eBay call will fail until the values are replaced by hand.

To correct a vault that already holds placeholders from an earlier bootstrap, overwrite them
explicitly — provisioning will not do it for you:

```bash
az keyvault secret set --vault-name "$KEY_VAULT" --name ebay-client-id     --value '<App ID>'
az keyvault secret set --vault-name "$KEY_VAULT" --name ebay-client-secret --value '<Cert ID>'
```

The initial app uses a placeholder image. `deploy.sh` builds the current commit in ACR, updates the
Container App, sets its public URLs, and verifies `/health`. Do not register the connector before
this step: until the real hostname is supplied, the generated OpenAPI document advertises
localhost.

## Deployment parameters

The fourth script argument selects the base ARM deployment-parameter file. When omitted, it defaults
to `infra/parameters/<environment>.parameters.json`, a committed portable baseline/example. When an
external file is supplied, that file replaces the baseline and is the authoritative operator state
for the deployment. Both scripts pass the selected file to **every** `az deployment sub create`;
this stops a routine release from silently reapplying a Bicep default for a persistent setting.

Precedence, lowest to highest:

1. defaults declared in `infra/main.bicep`;
2. the selected base parameter file — either the explicit authoritative operator file or the
   committed baseline when argument 4 is omitted. A missing file aborts the deployment rather than
   falling back to defaults;
3. an optional `.local.parameters.json` overlay adjacent to the selected base file, applied after
   it (overlays in this public repository are gitignored);
4. release-specific values passed on the command line by the scripts: `image`, `publicBaseUrl`,
   `accountDeletionEndpointUrl`, and `deployApp`.

Because an external file replaces rather than extends the public baseline, it should explicitly set
the complete persistent operator-controlled parameter surface. The committed baselines pin
`environmentName`, `location`, `ebayEnvironment`, `ebayMarketplaceId`,
`ebayDeliveryCountry`, `ebayDeliveryPostalCode`, `logLevel`, `minReplicas`, `maxReplicas`,
`enableHealthAlerts`, `alertEmails`, `alertSmsPhone`, `alertSmsCountryCode`, and `tags`.

The committed baselines are examples/defaults, not authoritative configuration for any particular
operator. Never commit alert addresses, phone numbers, subscription IDs, tenant IDs, operator
endpoints, or generated resource names to this public repository. Operators may keep non-secret
account configuration in an external private parameter file. Secrets are not parameters at all:
the connector API key, the eBay client id and secret, and the eBay account-deletion verification
token live only in Key Vault and reach the Container App as managed secret references.

`tests/unit/deployment-parameters.test.ts` and `scripts/verify-parameter-resolution.sh` run in CI
and fail if a new operator-facing parameter is added without being pinned in the portable baselines,
if either script stops passing the selected parameter file, or if an account-specific value is
committed to those baselines.

To preview a configuration change before applying it:

```bash
az deployment sub what-if \
  --location westus2 \
  --template-file infra/main.bicep \
  --parameters @infra/parameters/prod.parameters.json
```

## Post-merge production activation runbook

Follow these steps in order. Steps 1–4 stand the service up; step 5 makes the eBay application
compliant; steps 6–8 confirm real eBay data; steps 9–10 expose the capability to clients.

### Step 1 — Prepare credentials locally

Obtain the **production** App ID (client id) and Cert ID (client secret) from
[Application Keysets](https://developer.ebay.com/my/keys). No user OAuth is required: the Browse
capability uses the application client-credentials grant, so no eBay user consent step exists.

Put them in the environment rather than on a command line, so they do not enter shell history:

```bash
read -rs EBAY_CLIENT_ID && export EBAY_CLIENT_ID
read -rs EBAY_CLIENT_SECRET && export EBAY_CLIENT_SECRET
```

Both are **required** for a production target unless the vault already holds them. Provisioning
aborts up front rather than writing a placeholder; see
[eBay credentials are required, never placeheld](#ebay-credentials-are-required-never-placeheld).

### Step 2 — Provision Azure

```bash
./scripts/bootstrap/provision.sh <subscription-id> prod westus2 infra/parameters/prod.parameters.json
```

This creates or reuses the resource group, managed identity, container registry, Key Vault, Log
Analytics workspace, Container Apps environment, and Container App, and seeds the connector API key,
the eBay credentials, and the account-deletion verification token. Existing secrets are never
rotated, and an existing image is never rolled back to the placeholder.

### Step 3 — Deploy the real image

```bash
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2 infra/parameters/prod.parameters.json
```

The script reports the connector URL, `/health`, `/version`, `/openapi.json`, `/mcp`, the Marketplace
Account Deletion callback URL, the Key Vault name, and the safe retrieval commands for the connector
API key and the verification token. Neither secret is printed.

### Step 4 — Verify the hosted service before eBay registration

```bash
FQDN='<the host from the deploy summary>'

test "$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/health")"       = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/version")"      = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/openapi.json")" = "200"
test "$(curl -s -o /dev/null -w '%{http_code}' "https://$FQDN/tools")"        = "401"

API_KEY="$(az keyvault secret show --vault-name "$KEY_VAULT" --name connector-api-key --query value -o tsv)"
test "$(curl -s -o /dev/null -w '%{http_code}' -H "x-api-key: $API_KEY" "https://$FQDN/tools")" = "200"
unset API_KEY
```

Confirm `/version` reports `capabilities.accountDeletionEndpointConfigured: true` and that the
OpenAPI `servers` URL uses the public HTTPS hostname. Do **not** expect a successful production
Browse call yet: the production keyset may still be disabled pending compliance.

### Step 5 — Complete eBay Marketplace Account Deletion compliance

In the eBay developer portal:

**Application Keys → Production keyset → Alerts & Notifications → Marketplace Account Deletion.**

Provide:

- the alert **email address**, entered manually in the portal — it is deliberately not stored in this
  repository or in Azure;
- the **callback URL** exactly as printed by `deploy.sh`:
  `https://<fqdn>/ebay/notifications/marketplace-account-deletion`;
- the **verification token** from Key Vault:

  ```bash
  az keyvault secret show \
    --vault-name "$KEY_VAULT" \
    --name ebay-account-deletion-token \
    --query value -o tsv
  ```

Save. eBay immediately issues `GET <callback>?challenge_code=<value>`. The endpoint replies
`200 application/json` with `{"challengeResponse":"<sha256 hex>"}` and the endpoint is registered.

If registration fails, the near-certain cause is a mismatch between the URL entered in the portal and
`EBAY_ACCOUNT_DELETION_ENDPOINT_URL` in the Container App. eBay hashes that string verbatim; compare
them character for character, including any trailing slash:

```bash
az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='EBAY_ACCOUNT_DELETION_ENDPOINT_URL'].value" -o tsv
```

You can reproduce the expected hash locally without deploying anything:

```bash
printf '%s' "${CHALLENGE_CODE}${VERIFICATION_TOKEN}${ENDPOINT_URL}" | openssl dgst -sha256 -hex
```

Then use eBay's **Send Test Notification** control and confirm the `POST` path: the notification is
received, its `x-ebay-signature` verifies, and the endpoint acknowledges with `204`.

Healthy logs for the two operations look like this — note that no eBay account identifier appears in
either, and neither the verification token nor the payload is present:

```json
{
  "level": "info",
  "event": "ebay.account_deletion.challenge",
  "outcome": "answered",
  "msg": "answered eBay endpoint validation challenge"
}
```

```json
{
  "level": "info",
  "event": "ebay.account_deletion.processed",
  "topic": "MARKETPLACE_ACCOUNT_DELETION",
  "notificationId": "<eBay delivery id>",
  "publishAttemptCount": 1,
  "durationMs": 142,
  "outcome": "acknowledged",
  "msg": "eBay marketplace account deletion notification acknowledged"
}
```

A `412` in the response instead means the signature did not verify: check that the deployment can
reach `api.ebay.com` and that the Key Vault eBay credentials are real rather than the provisioning
placeholders, since the public key is fetched with an application access token.

The domain deletion action is a deliberate no-op. This service persists no eBay listing data, no eBay
user profile, and no notification payload, so there is nothing to erase. If that ever changes, the
deletion processor must be updated before the new feature is production-ready.

### Step 6 — Confirm production keyset activation

Once eBay shows the application as compliant, verify that the production credentials mint an
application token:

```bash
curl -fsS -X POST https://api.ebay.com/identity/v1/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -u "$EBAY_CLIENT_ID:$EBAY_CLIENT_SECRET" \
  -d 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope' \
  | jq 'has("access_token")'
```

### Step 7 — Run a real eBay Browse smoke test

With `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET` already exported:

```bash
EBAY_LIVE_TESTS=1 EBAY_ENVIRONMENT=production npm test
```

Use `EBAY_ENVIRONMENT=sandbox` with the sandbox keyset for a pre-production rehearsal. The live suite
is skipped unless `EBAY_LIVE_TESTS=1` and both credentials are present, so it never runs in CI. It
verifies OAuth token acquisition, a Browse search, a follow-up listing lookup, and normalization.

### Step 8 — Verify the deployed tool server against real eBay

```bash
API_KEY="$(az keyvault secret show --vault-name "$KEY_VAULT" --name connector-api-key --query value -o tsv)"

curl -fsS -H "x-api-key: $API_KEY" "https://$FQDN/tools" | jq '.tools[].name'

curl -fsS -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"query":"nintendo 64 console","limit":3}' \
  "https://$FQDN/tools/ebay_search_listings" | jq '.result.listings[0]'

curl -fsS -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"item":"<an item id returned above>"}' \
  "https://$FQDN/tools/ebay_get_listing" | jq '{kind:.result.kind, price:.result.listing.price, seller:.result.listing.seller}'

# A multi-variation listing answers with kind "itemGroup"; ebay_get_item_group fetches it directly.
curl -fsS -H "x-api-key: $API_KEY" -H 'content-type: application/json' \
  -d '{"itemGroup":"<an item group id>"}' \
  "https://$FQDN/tools/ebay_get_item_group" | jq '.result.itemGroup.items[] | {itemId, title, price}'

unset API_KEY
```

Confirm the prices and listing details match the live eBay site, that seller and shipping data behave
as expected (calculated shipping needs `ebayDeliveryCountry`/`ebayDeliveryPostalCode`), and that no
response claims sold or completed history — `/version` reports `soldListingData: false`, and the
Browse API exposes active listings only.

### Step 9 — Verify MCP

Exercise `https://$FQDN/mcp` with an MCP-compatible client. Confirm that:

- an unauthenticated `POST` returns `401`;
- `initialize` succeeds with the bearer token;
- `tools/list` returns exactly `ebay_get_listing`, `ebay_get_item_group`, `ebay_search_listings`,
  `ebay_find_similar_listings`, and `ebay_compare_listings`;
- one representative read invocation succeeds; and
- no persistent server-side session is required — each `POST` is independent, and `GET`/`DELETE`
  return `405`.

### Step 10 — Connect to ChatGPT

Two presentations are supported:

- **OpenAPI action.** Import `https://<host>/openapi.json` and configure API-key authentication with
  the connector key from Key Vault, sent as a bearer token or `x-api-key`.
- **Streamable HTTP MCP.** Point an MCP-capable client at `https://<host>/mcp` with the same
  credential as a bearer token.

Which of these is available depends on the ChatGPT plan and surface in use; verify against the
current ChatGPT connector configuration rather than assuming. The account-deletion callback is
deliberately excluded from the OpenAPI document — it is infrastructure for eBay, not a capability for
an agent to invoke.

`server.json` continues to omit `remotes`: no hosted endpoint is published there, and a private
deployment URL must not be added to it.

## Legacy deployment compatibility

The Bicep defaults and bootstrap scripts continue to find and update the deployed
`rg-chatgpt-ebay-*`, `ca-chatgpt-ebay-*`, `cae-chatgpt-ebay-*`, `id-chatgpt-ebay-*`, and
`log-chatgpt-ebay-*` resources, the generated `acrchatgptebay*` registry and `kv-cgeb-*` vault, the
private `chatgpt-ebay` ACR repository, and the existing `chatgpt-ebay-*` deployment and monitoring
history. Changing those values in place would create or target different resources and could
orphan Key Vault secrets, managed-identity assignments, monitoring, revisions, rollback tags, or
the stable Container App hostname.

The application identity is separate: Bicep sets `SERVICE_NAME=agent-tool-server-ebay`, and public
package, image examples, metadata, and documentation use the new name. A fully renamed Azure
environment is optional follow-up work requiring a planned secret, identity, DNS, RBAC, monitoring,
and rollback migration. These scripts do not perform that destructive migration.

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
- `/version` reports `capabilities.accountDeletionEndpointConfigured: true`;
- the configured marketplace and buyer location are appropriate; and
- application logs reach the intended workspace.

## Configure eBay behavior

Change `ebayEnvironment`, `ebayMarketplaceId`, `ebayDeliveryCountry`, and `ebayDeliveryPostalCode`
in `infra/parameters/<environment>.parameters.json` — not on the command line — so the setting
persists across every subsequent release. Preview the change first:

```bash
az deployment sub what-if \
  --location westus2 \
  --template-file infra/main.bicep \
  --parameters @infra/parameters/prod.parameters.json
```

Then apply it with a normal deployment:

```bash
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2
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

Rolling back the image never rolls back environment configuration: the parameter file at the checked
out commit is the one that applies, so review it as part of any rollback.

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
the credential configured in each client after rotating the connector key, and verify that the old key
is rejected.

Rotating the account-deletion verification token is a **coordinated** change, because eBay stores its
own copy. Write the new value, restart the revision, and immediately re-save the callback URL and the
new token in the eBay developer portal so eBay reissues its challenge against the new value. Until
both sides agree, the challenge fails and eBay can mark the endpoint down.

```bash
NEW_TOKEN="$(openssl rand -hex 24)"
az keyvault secret set \
  --vault-name "$KEY_VAULT" \
  --name ebay-account-deletion-token \
  --value "$NEW_TOKEN" \
  --output none
unset NEW_TOKEN
```

Running `provision.sh` again never rotates any of these secrets; it only creates the ones that are
missing.

Avoid passing secrets in command history, CI output, issue reports, or screenshots.

## Open item: bound the trusted proxy configuration

**Status: deferred pending a deployed environment. Verify this after the first production deploy.**

The Fastify server is configured with `trustProxy: true`, which makes it accept the entire
caller-supplied `X-Forwarded-For` chain when deriving `request.ip`. A caller can therefore forge
that header and present an arbitrary address.

What this does and does not affect:

- **Not affected:** the per-principal rate limit on `/tools` and `/mcp`, which is keyed on the
  authenticated API key rather than on an address, and authentication itself.
- **Not affected:** the eBay account-deletion callback's real ceiling, which is the global outbound
  key-lookup budget and negative caching in `NotificationApiPublicKeyProvider` — deliberately
  independent of anything the caller controls.
- **Affected:** the pre-authentication flood limiter and the callback's per-address limit, both of
  which are defence in depth only. A caller rotating `X-Forwarded-For` gets a fresh bucket each
  request.

This was left unchanged rather than tightened, deliberately:

1. There is no bounded hop-count convention to follow. Across the sibling hosted tool servers,
   eight set `trustProxy: false`, two (this repo and `agent-tool-server-azure`) set `true`, and one
   (`agent-tool-server-data-cruncher`) makes it configurable via `TRUST_PROXY` with a default of
   `false`. `agent-tool-platform` has no shared implementation.
2. No repository documents the Azure Container Apps ingress hop count, and it cannot be established
   from the Bicep alone.
3. Guessing is worse than leaving it. Too high a hop count leaves the header forgeable anyway; too
   low collapses every caller onto the ingress address, putting all traffic in a single
   rate-limit bucket and turning the limiter into a self-inflicted outage.

**Verification procedure once an environment exists.** Send a request through the public ingress
with a known-fake prefix and observe what the application actually receives:

```bash
curl -fsS -H 'x-forwarded-for: 203.0.113.9' "https://$FQDN/health" -o /dev/null

az containerapp logs show --resource-group "$RESOURCE_GROUP" --name "$APP_NAME" --tail 50 \
  | grep -o '"remoteAddress":"[^"]*"'
```

Count the entries the ingress appends to the chain. If that count is stable, replace
`trustProxy: true` in [`src/server/http.ts`](../src/server/http.ts) with that integer, following
the `TRUST_PROXY` configuration shape already used by `agent-tool-server-data-cruncher` so the
portfolio converges on one pattern: a value that distinguishes an integer hop count from boolean
`true`, bounded by default in production, and permissive for local development. Add a test proving
that a forged `X-Forwarded-For` prefix cannot create arbitrary rate-limit buckets while the trusted
ingress suffix is unchanged.

## Monitoring and logs

Tail structured container logs during an investigation:

```bash
az containerapp logs show \
  --resource-group "$RESOURCE_GROUP" \
  --name "$APP_NAME" \
  --follow
```

The Bicep template can create an availability test and action group. Set `enableHealthAlerts` to
`true` and provide `alertEmails` or `alertSmsPhone` in the gitignored
`infra/parameters/<environment>.local.parameters.json` overlay. Do not commit personal contact
details to the tracked parameter files.

Monitor at least:

- `/health` availability and latency;
- HTTP 401, 429, and 5xx rates;
- eBay OAuth failures, timeouts, and throttling;
- `ebay.account_deletion.processed` volume and any `412` on the callback, which would mean eBay
  notifications are being rejected;
- Container App restarts and failed revisions; and
- Log Analytics ingestion against its daily cap.

Account-deletion logs deliberately contain no eBay account identifier and no payload. `username`,
`userId`, and `eiasToken` must never appear in any query result; if they do, treat it as a privacy
incident and fix the log site before anything else.

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

### eBay will not register the account-deletion endpoint

eBay hashes the callback URL verbatim. Compare the string entered in the portal with the value the
container actually holds; a differing scheme, host, path, or trailing slash produces a different
`challengeResponse` and registration fails.

```bash
az containerapp show --name "$APP_NAME" --resource-group "$RESOURCE_GROUP" \
  --query "properties.template.containers[0].env[?name=='EBAY_ACCOUNT_DELETION_ENDPOINT_URL'].value" -o tsv
```

### The account-deletion callback returns 404

The route is mounted only when both `EBAY_ACCOUNT_DELETION_ENDPOINT_URL` and
`EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` are present. A partially configured endpoint would answer
eBay's challenge with the wrong hash, so it is deliberately not mounted at all. Confirm the Key Vault
secret exists and rerun `deploy.sh`, which supplies the URL.

### The test notification returns 412

The `x-ebay-signature` did not verify. The public key is fetched from
`https://api.ebay.com/commerce/notification/v1/public_key/{kid}` with an application access token, so
confirm that the Key Vault eBay credentials are real rather than the provisioning placeholders and
that the Container App has outbound access to `api.ebay.com`.

### A Container App revision fails with "Unable to get value using Managed identity"

A Key Vault secret referenced by the template does not exist. The current set is `connector-api-key`,
`ebay-client-id`, `ebay-client-secret`, and `ebay-account-deletion-token`. Rerun `provision.sh`; it
creates only the missing ones and never rotates an existing value. `deploy.sh` checks for the
account-deletion secret up front and fails with this remediation rather than producing a broken
revision.

## Remove an environment

Export any required logs first. Deleting the generated resource group removes the app, registry,
vault, and workspace:

```bash
az group delete --name rg-chatgpt-ebay-prod
```

Remove client registrations and revoke any copied connector or eBay credentials. If the environment
had a registered account-deletion callback, remove it from the eBay developer portal as well;
otherwise eBay will keep delivering notifications to a dead URL and eventually mark the endpoint
down and email the alert contact.
