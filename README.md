# agent-tool-server-ebay

[![CI](https://github.com/ashergarland/agent-tool-server-ebay/actions/workflows/ci.yml/badge.svg)](https://github.com/ashergarland/agent-tool-server-ebay/actions/workflows/ci.yml)
[![Security](https://github.com/ashergarland/agent-tool-server-ebay/actions/workflows/security.yml/badge.svg)](https://github.com/ashergarland/agent-tool-server-ebay/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**eBay Marketplace** is a read-only agent tool server for retrieving, searching, and comparing
current eBay listings through the official eBay Browse API. It exposes one typed tool registry
through HTTP/OpenAPI, local stdio MCP, and stateless Streamable HTTP MCP.

This independent project is not endorsed by, affiliated with, or sponsored by eBay.

> [!IMPORTANT]
> The server works with active-listing data. It does not provide completed-item search, historical
> sold prices, sales frequency, recent-sales history, or unrestricted marketplace analytics.

## Capabilities

All tools are read-only and non-consequential:

| Tool                         | Verified behavior                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------ |
| `ebay_get_listing`           | Retrieves one listing by eBay URL, mobile share link, numeric ID, or Browse API ID.        |
| `ebay_get_item_group`        | Retrieves every purchasable variation of a multi-variation listing (item group).           |
| `ebay_search_listings`       | Searches active listings with bounded keyword, category, seller, price, and other filters. |
| `ebay_find_similar_listings` | Finds active comparables using EPID, GTIN, MPN, category, and title keywords when present. |
| `ebay_compare_listings`      | Compares two or more listings, including price, shipping, condition, seller, and returns.  |

### Item identifiers and variation groups

eBay uses two identifier spaces that are not interchangeable, and the server keeps them apart:

- A RESTful Browse item ID (`v1|407111131587|0`) is sent unchanged to `getItem`. It is never
  rewritten into a legacy lookup.
- A numeric legacy ID (`407111131587`), including one parsed out of an `/itm/<id>` URL, is resolved
  through `getItemByLegacyId`.
- Listing-oriented tools accept mobile share links copied from the eBay app, such as
  `https://ebay.io/m/...`. The server resolves the allowlisted redirect and sends the resulting
  `/itm/...` URL through the same listing-reference parser and Browse API flow as a normal URL.
- A legacy ID can also identify an _item group_: a multi-variation listing. eBay reports this with
  structured error ID 11006 rather than returning an item. `ebay_get_listing` recognizes that error
  ID, resolves the group through `getItemsByItemGroup`, and answers with `kind: "itemGroup"` plus
  every individual variation. `ebay_get_item_group` does the same lookup directly.

Search results carry `itemGroupType` and `itemGroupId` when eBay reports them, so a row that is a
variation group can be routed to `ebay_get_item_group` instead of `ebay_get_listing`.

Depending on what eBay returns, listing details can include current price or bid, shipping options,
estimated delivered total, condition, seller feedback, item location, return terms, availability,
provider-reported estimated sold quantity, category, item specifics, product identifiers, and
images. `availability.soldQuantity`, when present, normalizes eBay's `estimatedSoldQuantity` field
for the current listing. It is not completed listing history, a sales timeline, or a sales-frequency
calculation.

Search and comparison prices are active asking prices or current auction bids. The server does not
turn them into a valuation or buying recommendation.

### Provider limitations and approval

- Browse search covers active inventory, not sold or completed inventory.
- The limited-release eBay Marketplace Insights API can expose completed-item data, but this server
  does not call it. Access requires separate eBay approval and is not assumed.
- Production Buy API access may require eBay approval. Sandbox behavior is available with a sandbox
  keyset and `EBAY_ENVIRONMENT=sandbox`.
- Calculated shipping is often absent unless `EBAY_DELIVERY_COUNTRY` and
  `EBAY_DELIVERY_POSTAL_CODE` supply buyer context.
- The server uses documented eBay APIs only and does not scrape eBay pages.

## Architecture

```text
HTTP/OpenAPI   stdio MCP   Streamable HTTP MCP
           \      |      /
             ToolRegistry
                  |
               Services
                  |
           EbayProvider port
                  |
        official eBay Browse API
```

`src/tools/definitions.ts` is the single source of truth for tool names, summaries, safety kind,
Zod input/output schemas, and handlers. Every transport uses the same `ToolRegistry`. Services own
listing and comparison behavior; the provider adapter alone knows eBay endpoints and response
shapes. Inputs and outputs are validated at the registry boundary.

| Layer     | Location                | Responsibility                                            |
| --------- | ----------------------- | --------------------------------------------------------- |
| Transport | `src/server`, `src/mcp` | HTTP/MCP protocol, authentication, rate limits, errors.   |
| Tools     | `src/tools`             | Typed definitions, Zod schemas, shared registry.          |
| Services  | `src/services`          | Listing, search, comparable, comparison, and guardrails.  |
| Provider  | `src/provider`          | eBay port, OAuth, REST calls, normalization, safe errors. |
| Config    | `src/config`            | Validated and normalized environment configuration.       |
| OpenAPI   | `src/openapi`           | OpenAPI 3.1 generated from the shared registry.           |

## Transports and endpoints

| Method | Path                                               | Authentication | Purpose                                 |
| ------ | -------------------------------------------------- | -------------- | --------------------------------------- |
| `GET`  | `/health`                                          | Public         | Liveness and readiness probe            |
| `GET`  | `/version`                                         | Public         | Build, provider, and transport metadata |
| `GET`  | `/openapi.json`                                    | Public         | Generated OpenAPI 3.1 document          |
| `GET`  | `/tools`                                           | Required       | Tool catalogue and JSON Schemas         |
| `POST` | `/tools/{toolName}`                                | Required       | Invoke one tool                         |
| `POST` | `/mcp`                                             | Required       | Stateless Streamable HTTP MCP           |
| `GET`  | `/ebay/notifications/marketplace-account-deletion` | eBay challenge | eBay endpoint validation                |
| `POST` | `/ebay/notifications/marketplace-account-deletion` | eBay signature | eBay account deletion notification      |

The account-deletion callback is mounted only when both
`EBAY_ACCOUNT_DELETION_ENDPOINT_URL` and `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` are set. See
[eBay marketplace account deletion compliance](#ebay-marketplace-account-deletion-compliance).

The Streamable HTTP endpoint creates a fresh MCP server and transport per POST and keeps no
server-side MCP session store. GET and DELETE return 405 instead of opening persistent streams,
which preserves scale-to-zero behavior. Local stdio MCP runs through:

```bash
npm run build
npm run mcp:stdio
```

The package also declares the executable name `agent-tool-server-ebay-mcp` for a future package
distribution. The package is currently private and unpublished, so that command is not advertised
as remotely installable.

## Authentication and security

Inbound caller authentication and outbound eBay credentials are separate:

- `AUTH_MODE=api-key` is the default. `API_KEYS` contains comma-separated keys of at least 32
  characters. Both `x-api-key` and `Authorization: Bearer` are accepted.
- Keys are compared as fixed-width HMAC digests with constant-time comparison. Logs contain only a
  non-reversible per-process fingerprint.
- `AUTH_MODE=disabled` is development-only and is rejected in production.
- eBay uses OAuth client credentials from `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`; tokens are
  cached in memory, refreshed early, and never logged.
- Mobile share links are resolved with manual redirects, a five-second timeout and a three-hop
  limit. Only the observed `ebay.io` to `www.ebay.com` path is allowed; redirect requests omit
  credentials and never carry connector keys, OAuth tokens, cookies or authorization headers.
- The eBay account-deletion callback is deliberately unauthenticated by connector key — eBay cannot
  present one — and is authenticated instead by the `x-ebay-signature` it carries. It is a
  fixed two-operation surface on one path, is per-address rate limited, bounds its outbound eBay
  key lookups with a global budget and negative caching, and is excluded from the OpenAPI document
  and the tool catalogue.

Additional controls include a 1 MB request-body limit, bounded request IDs, per-principal and
pre-auth rate limiting, provider timeouts and bounded retries, bounded result and comparison sizes,
secret redaction, safe upstream error mapping, generic production 5xx responses, and a non-root
container. The implementation calls only eBay `GET` endpoints; it cannot buy, bid, list, revise, or
message.

## Configuration

Copy `.env.example` and provide placeholders or real values outside source control.

| Variable                                              | Default              | Notes                                                 |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------------- |
| `PORT` / `HOST`                                       | `8080` / `0.0.0.0`   | HTTP listener.                                        |
| `SERVICE_NAME` / `SERVICE_VERSION`                    | project / `0.1.0`    | Public runtime identity.                              |
| `LOG_LEVEL`                                           | `info`               | Structured pino logging level.                        |
| `PUBLIC_BASE_URL`                                     | local URL            | OpenAPI server URL; use public HTTPS when deployed.   |
| `AUTH_MODE` / `API_KEYS`                              | `api-key` / required | Inbound caller authentication.                        |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`               | unset                | Required together, and required in production.        |
| `EBAY_ENVIRONMENT`                                    | `production`         | `production` or `sandbox`.                            |
| `EBAY_MARKETPLACE_ID`                                 | `EBAY_US`            | Default marketplace.                                  |
| `EBAY_OAUTH_SCOPES`                                   | public API scope     | Comma-separated client-credential scopes.             |
| `EBAY_DELIVERY_COUNTRY` / `EBAY_DELIVERY_POSTAL_CODE` | unset                | Optional buyer context for calculated shipping.       |
| `EBAY_AFFILIATE_CAMPAIGN_ID`                          | unset                | Optional eBay Partner Network campaign ID.            |
| `EBAY_SEARCH_DEFAULT_LIMIT` / `EBAY_SEARCH_MAX_LIMIT` | `20` / `50`          | Search result guardrails.                             |
| `EBAY_COMPARE_MAX_ITEMS`                              | `8`                  | Comparison guardrail; schema maximum is 20.           |
| `REQUEST_TIMEOUT_MS`                                  | `30000`              | eBay request and OAuth timeout.                       |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`             | `120` / `60000`      | In-process fixed-window limit; `0` disables.          |
| `EBAY_ACCOUNT_DELETION_ENDPOINT_URL`                  | unset                | Exact public HTTPS callback URL registered with eBay. |
| `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN`            | unset                | **Secret.** 32–80 characters of `A–Z a–z 0–9 _ -`.    |

Blank optional environment variables are normalized to “unset.” This avoids startup failures when
deployment platforms materialize an omitted optional value as an empty string.

## eBay marketplace account deletion compliance

eBay requires every production application either to expose a Marketplace Account Deletion/Closure
notification endpoint or to hold an exemption. This server implements the endpoint. It lives in
[`src/compliance/ebay-account-deletion`](src/compliance/ebay-account-deletion), is self-contained,
and is registered as an encapsulated Fastify plugin so it can later move behind a shared platform's
route-extension mechanism without touching the rest of the server.

**Endpoint validation (`GET`).** eBay calls
`GET <endpoint>?challenge_code=<value>` and the server replies `200 application/json` with
`{"challengeResponse": "<hex>"}`, where the value is
`sha256(challengeCode + verificationToken + endpointUrl)` in lowercase hexadecimal. The response is
produced by a JSON serializer, never by string concatenation, because eBay rejects a body carrying a
byte order mark. `EBAY_ACCOUNT_DELETION_ENDPOINT_URL` must match the portal entry byte for byte,
including any trailing slash.

**Notification handling (`POST`).** The `x-ebay-signature` header is base64-decoded into
`{alg, kid, signature, digest}`; the public key named by `kid` is fetched from the official
Notification API (`/commerce/notification/v1/public_key/{kid}`) using the same eBay client-credentials
OAuth machinery the Browse tools already use, and cached for one hour in a size-bounded cache. The
header's `alg` and `digest` are then cross-checked case-insensitively against the `algorithm` and
`digest` eBay reports for that key, and a disagreement is rejected before any cryptography is
attempted — the header is attacker-supplied, the key metadata is not. Only then is the ECDSA
signature verified over the received bytes, and only after that is the payload validated against the
`MARKETPLACE_ACCOUNT_DELETION` schema. A verified notification is acknowledged with `204`, an
unverifiable signature with `412`, and a malformed request with a bounded `4xx`.

The comparison is case-insensitive by necessity, not convenience: eBay's own published test vector
sends `"alg":"ecdsa"` in the header while `getPublicKey` reports `"algorithm":"ECDSA"`.

Because the callback must be public, the key lookup it triggers is bounded independently of anything
the caller controls: failed lookups are remembered briefly so a replayed unknown `kid` cannot be
amplified, and a global fixed-window budget caps outbound Notification API calls. A per-address limit
alone would not do this — the service runs behind ingress with `trustProxy` enabled, so `request.ip`
comes from a caller-supplied `X-Forwarded-For`.

**Data retention.** The domain deletion step is a deliberate no-op. This server persists no eBay
listing responses, no eBay user profiles and no notification payloads, and never writes `username`,
`userId` or `eiasToken` to logs or telemetry — so there is nothing to erase and a redelivery is
inherently idempotent. Operational logs record only the event name, the eBay-generated notification
id, the publish attempt count, the duration and the outcome. If persistent eBay user data is ever
added, `AccountDeletionService.deleteStoredUserData` must delete from it irreversibly before that
feature can ship.

**Why not the official SDK.** `event-notification-nodejs-sdk` was evaluated first and rejected: it is
CommonJS-only with no type declarations, last released in June 2023, depends on `axios@^0.21`,
`express@^4` and `lru-cache@^6` in production, caches keys without a TTL, and logs the closed
account's `userId` and `username` through `console.log` with no injectable logger. The protocol it
implements is reproduced here field for field against its `lib/validator.js` and the Notification API
documentation, with no new runtime dependency.

The full activation runbook — provisioning, registration, the endpoint challenge, the test
notification, keyset activation and ChatGPT connection — is in
[docs/deployment.md](docs/deployment.md#post-merge-production-activation-runbook).

## Local development

Requirements: Node.js 22+, npm, and an eBay developer keyset for real provider calls.

```bash
git clone https://github.com/ashergarland/agent-tool-server-ebay.git
cd agent-tool-server-ebay
npm ci
cp .env.example .env
npm run dev
```

Use a random API key of at least 32 characters. The default test suite is hermetic and never needs
live eBay credentials:

```bash
npm run format:check
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run openapi:emit -- openapi.json
npm run openapi:validate
npm run metadata:validate
```

Live Browse tests are opt-in and never run in CI. Supply credentials through the environment
rather than on the command line so they do not enter shell history:

```bash
# Sandbox
read -rs EBAY_CLIENT_ID; read -rs EBAY_CLIENT_SECRET
export EBAY_CLIENT_ID EBAY_CLIENT_SECRET
EBAY_LIVE_TESTS=1 EBAY_ENVIRONMENT=sandbox npm test

# Production, only after the account-deletion endpoint is registered and the keyset is enabled
EBAY_LIVE_TESTS=1 EBAY_ENVIRONMENT=production npm test
```

## Container

The multi-stage Node 22 image installs from the lockfile, removes development dependencies, runs as
the unprivileged `node` user, and includes a `/health` check.

```bash
docker build -t agent-tool-server-ebay .
docker run --rm -p 8080:8080 \
  -e API_KEYS="$(openssl rand -hex 32)" \
  -e EBAY_CLIENT_ID="..." \
  -e EBAY_CLIENT_SECRET="..." \
  agent-tool-server-ebay
```

No public container image is currently claimed. Build locally or use the documented private Azure
Container Registry deployment.

## Azure provisioning and deployment

The subscription-scoped Bicep creates a resource group, user-assigned identity, Azure Container
Registry, Key Vault, Log Analytics workspace, Container Apps environment, Container App, and
optional availability monitoring. The identity receives only `AcrPull` on its registry and Key
Vault secret-read access on its vault.

```bash
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... \
  ./scripts/bootstrap/provision.sh <subscription-id> prod westus2 infra/parameters/prod.parameters.json
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2 infra/parameters/prod.parameters.json
```

The parameter file is optional on the command line — both scripts default to
`infra/parameters/<environment>.parameters.json` — but it is never optional to the deployment.
Every `az deployment sub create` in both scripts passes it, so a release cannot silently reapply a
Bicep default for the eBay environment, marketplace, buyer delivery context, log level, replica
scaling or alerting. Parameter precedence, lowest to highest:

1. defaults declared in `infra/main.bicep`;
2. `infra/parameters/<environment>.parameters.json` — committed, canonical, required;
3. `infra/parameters/<environment>.local.parameters.json` — gitignored operator overlay for
   account-specific values such as alert recipients;
4. release-specific command-line values: `image`, `publicBaseUrl`, `accountDeletionEndpointUrl`
   and `deployApp`.

Secrets never appear in any of these: the connector API key, the eBay client id and secret, and the
eBay account-deletion verification token live only in Key Vault and reach the Container App as
managed secret references.

Provisioning is intentionally multi-pass. Pass one creates the identity, registry, vault, logging,
and role assignments. The script grants the current operator Key Vault secret-write access, waits
for propagation, and writes required secrets; a failed write aborts and an existing secret is never
rotated. Pass two creates the app only after its managed identity can resolve the Key Vault
references. Pass three applies `PUBLIC_BASE_URL` and the account-deletion callback URL, which cannot
be known until ingress exists. `deploy.sh` then builds a commit-tagged image, reads the existing
public hostname, redeploys with that image and both URLs, and verifies health. Commit tags provide a
rollback target.

Both scripts print the connector, health, OpenAPI, MCP and account-deletion callback URLs, the Key
Vault name, and the commands for retrieving the connector API key and the verification token. Neither
secret value is ever printed automatically.

### Retained legacy Azure names

Existing deployments predate the public repository rename. The following compatibility identifiers
remain intentionally unchanged because renaming them would create parallel resources, orphan
secrets or RBAC, break scripts, lose rollback history, or change the connector URL:

- `rg-chatgpt-ebay-<environment>` resource groups;
- `ca-chatgpt-ebay-<environment>` Container Apps;
- `cae-chatgpt-ebay-<environment>` Container Apps environments;
- `id-chatgpt-ebay-<environment>` managed identities;
- `log-chatgpt-ebay-<environment>` Log Analytics workspaces;
- `acrchatgptebay...` registries and `kv-cgeb-...` Key Vaults;
- the private ACR repository `chatgpt-ebay`;
- `chatgpt-ebay-...` deployment-history and monitoring resource names.

These are infrastructure compatibility names only. The running service reports
`agent-tool-server-ebay`. New public examples, local images, package metadata, and CI artifacts use
the renamed identity. A future destructive resource migration should be planned separately with
secret, identity, DNS, monitoring, RBAC, and rollback cutovers; this change does not deploy or
rename Azure resources.

For permissions, updates, rollback, credential rotation, monitoring, and teardown, see
[`docs/deployment.md`](docs/deployment.md).

## Monitoring and cost behavior

The Container App uses HTTPS-only ingress, liveness/readiness probes, 0.25 CPU, 0.5 GiB memory,
HTTP scaling, and `minReplicas: 0`. Scale-to-zero minimizes personal-use cost but causes a cold start
on the first request after idle time. Log Analytics retains 30 days and caps ingestion at 1 GB/day.
Optional external `/health` checks and alerts are disabled unless recipients are supplied.

The in-process rate limiter is per replica, not a distributed global quota. Put a gateway in front
of the service if callers need a cross-replica limit.

## Metadata, publication, and registration

Root `server.json` uses the official MCP metadata schema and the canonical MCP name
`io.github.ashergarland/agent-tool-server-ebay`. It intentionally omits `packages` and `remotes`:

- the npm package is private and not published;
- no public container image is claimed;
- no stable hosted MCP endpoint is claimed;
- the server is not claimed as published in the official MCP Registry or Docker MCP catalog.

The family registry already contains
`entries/agent-tool-server-ebay.json` in `ashergarland/agent-tool-server-registry`, currently marked
as a source-metadata mismatch. After this repository PR merges, the exact follow-up is a separate
registry PR that:

1. updates that existing entry (not a new entry);
2. adds `streamable-http` to `interfaces.transports`;
3. removes `oauth2` from inbound `interfaces.authentication` because OAuth is used only outbound to
   eBay, retaining `api-key` and `bearer-token`;
4. marks `EBAY_CLIENT_ID` as non-secret and defaulted `AUTH_MODE` / `EBAY_ENVIRONMENT` as not
   required, while keeping connector keys and the eBay client secret classified as secrets;
5. changes provenance to `{ "kind": "server-json", "location": "server.json" }`;
6. updates `lastVerifiedCommit` to this repository's merge commit;
7. changes review status from `mismatch` to `reviewed` after verification and removes resolved notes;
8. keeps all npm, container, hosted, official MCP Registry, and Docker catalog distribution claims
   omitted; and
9. runs `npm run catalog:generate`, `npm run verify`, and `npm run verify:online`, committing the
   regenerated `catalog.json`.

The application has no runtime dependency on the family registry.

## Testing and CI

Vitest covers configuration normalization, authentication, rate limiting, provider/OAuth behavior,
normalization, service guardrails, all tool schemas, OpenAPI, HTTP, stdio-compatible MCP,
Streamable HTTP MCP, eBay account-deletion challenge/schema/signature/public-key-caching behavior,
and deployment parameter integrity. Fakes prevent default tests from calling eBay; the
account-deletion signature tests generate their own P-256 key pair, so no eBay credential is ever
required.

Those generated-key tests prove the implementation is self-consistent, which a self-consistent
implementation of the _wrong_ protocol would also achieve. `tests/unit/compliance/published-fixture.test.ts`
closes that gap by verifying eBay's own published test vector from the official
`event-notification-nodejs-sdk` — public sample data, committed with its upstream URL and blob SHA,
and still requiring no network call or credential.

CI enforces lockfile installation, formatting, lint, typecheck, coverage, production build,
OpenAPI generation, official-schema `server.json` validation, container build and smoke tests
(including a live challenge-hash check computed independently with `openssl`), Bicep build/lint,
shell syntax, deployment parameter resolution, dependency audit/review, secret scanning, and CodeQL.
CI does not deploy.

## Troubleshooting

| Symptom                                | Likely cause and response                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Startup `ConfigurationError`           | Correct the named variable; common causes are short keys, partial eBay credentials, or disabled production auth.                                             |
| `/tools` or `/mcp` returns 401         | Supply the configured `x-api-key` or bearer token.                                                                                                           |
| eBay returns 401/403                   | Match the keyset to `EBAY_ENVIRONMENT`; production Browse access may require approval.                                                                       |
| Listing is 404 but exists in a browser | Pass its marketplace or use the full eBay country-site URL.                                                                                                  |
| Delivered total is missing             | eBay omitted shipping; configure buyer country and postal code.                                                                                              |
| Search has no sold results             | Expected: Browse search contains active listings only.                                                                                                       |
| First Azure deployment cannot read KV  | Use `provision.sh`; do not skip its foundation, role propagation, and secret-write pass.                                                                     |
| OpenAPI advertises localhost           | Run `deploy.sh` so it discovers the existing FQDN and sets `PUBLIC_BASE_URL`.                                                                                |
| First request is slow                  | A scale-to-zero cold start is expected; raise `minReplicas` only after accepting the cost.                                                                   |
| eBay rejects the callback registration | The hashed endpoint must equal the portal entry exactly; compare `EBAY_ACCOUNT_DELETION_ENDPOINT_URL` character for character, including any trailing slash. |
| Callback returns 404                   | Both `EBAY_ACCOUNT_DELETION_ENDPOINT_URL` and `EBAY_ACCOUNT_DELETION_VERIFICATION_TOKEN` must be set; the route is unmounted otherwise.                      |
| Test notification returns 412          | The signature did not verify. Confirm the deployment can reach `api.ebay.com` and that the eBay credentials in Key Vault are real.                           |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and [SECURITY.md](SECURITY.md) for private
vulnerability reporting. This project is available under the [MIT License](LICENSE).
