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
| `ebay_get_listing`           | Retrieves one listing by eBay URL, numeric item ID, or Browse API item ID.                 |
| `ebay_search_listings`       | Searches active listings with bounded keyword, category, seller, price, and other filters. |
| `ebay_find_similar_listings` | Finds active comparables using EPID, GTIN, MPN, category, and title keywords when present. |
| `ebay_compare_listings`      | Compares two or more listings, including price, shipping, condition, seller, and returns.  |

Depending on what eBay returns, listing details can include current price or bid, shipping options,
estimated delivered total, condition, seller feedback, item location, return terms, availability,
provider-reported sold quantity, category, item specifics, product identifiers, and images.
`availability.soldQuantity`, when present, is a field on the current listing. It is not completed
listing history, a sales timeline, or a sales-frequency estimate.

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

| Method            | Path                | Authentication | Purpose                                 |
| ----------------- | ------------------- | -------------- | --------------------------------------- |
| `GET`             | `/health`           | Public         | Liveness and readiness probe            |
| `GET`             | `/version`          | Public         | Build, provider, and transport metadata |
| `GET`             | `/openapi.json`     | Public         | Generated OpenAPI 3.1 document          |
| `GET`             | `/tools`            | Required       | Tool catalogue and JSON Schemas         |
| `POST`            | `/tools/{toolName}` | Required       | Invoke one tool                         |
| `GET/POST/DELETE` | `/mcp`              | Required       | Stateless Streamable HTTP MCP           |

The Streamable HTTP endpoint creates a fresh MCP server and transport per request and keeps no
server-side MCP session store. Local stdio MCP runs through:

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

Additional controls include a 1 MB request-body limit, bounded request IDs, per-principal and
pre-auth rate limiting, provider timeouts and bounded retries, bounded result and comparison sizes,
secret redaction, safe upstream error mapping, generic production 5xx responses, and a non-root
container. The implementation calls only eBay `GET` endpoints; it cannot buy, bid, list, revise, or
message.

## Configuration

Copy `.env.example` and provide placeholders or real values outside source control.

| Variable                                              | Default              | Notes                                               |
| ----------------------------------------------------- | -------------------- | --------------------------------------------------- |
| `PORT` / `HOST`                                       | `8080` / `0.0.0.0`   | HTTP listener.                                      |
| `SERVICE_NAME` / `SERVICE_VERSION`                    | project / `0.1.0`    | Public runtime identity.                            |
| `LOG_LEVEL`                                           | `info`               | Structured pino logging level.                      |
| `PUBLIC_BASE_URL`                                     | local URL            | OpenAPI server URL; use public HTTPS when deployed. |
| `AUTH_MODE` / `API_KEYS`                              | `api-key` / required | Inbound caller authentication.                      |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`               | unset                | Required together, and required in production.      |
| `EBAY_ENVIRONMENT`                                    | `production`         | `production` or `sandbox`.                          |
| `EBAY_MARKETPLACE_ID`                                 | `EBAY_US`            | Default marketplace.                                |
| `EBAY_OAUTH_SCOPES`                                   | public API scope     | Comma-separated client-credential scopes.           |
| `EBAY_DELIVERY_COUNTRY` / `EBAY_DELIVERY_POSTAL_CODE` | unset                | Optional buyer context for calculated shipping.     |
| `EBAY_AFFILIATE_CAMPAIGN_ID`                          | unset                | Optional eBay Partner Network campaign ID.          |
| `EBAY_SEARCH_DEFAULT_LIMIT` / `EBAY_SEARCH_MAX_LIMIT` | `20` / `50`          | Search result guardrails.                           |
| `EBAY_COMPARE_MAX_ITEMS`                              | `8`                  | Comparison guardrail; schema maximum is 20.         |
| `REQUEST_TIMEOUT_MS`                                  | `30000`              | eBay request and OAuth timeout.                     |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`             | `120` / `60000`      | In-process fixed-window limit; `0` disables.        |

Blank optional environment variables are normalized to “unset.” This avoids startup failures when
deployment platforms materialize an omitted optional value as an empty string.

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

Live Browse tests are opt-in:

```bash
EBAY_LIVE_TESTS=1 EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... npm test
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
  ./scripts/bootstrap/provision.sh <subscription-id> prod westus2
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2
```

Provisioning is intentionally two-pass. Pass one creates the identity, registry, vault, logging,
and role assignments. The script grants the current operator Key Vault secret-write access, waits
for propagation, and writes required secrets; a failed write aborts. Pass two creates the app only
after its managed identity can resolve the Key Vault references. `deploy.sh` then builds a
commit-tagged image, reads the existing public hostname, redeploys with that image and
`PUBLIC_BASE_URL`, and verifies health. Commit tags provide a rollback target.

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
3. changes provenance to `{ "kind": "server-json", "location": "server.json" }`;
4. updates `lastVerifiedCommit` to this repository's merge commit;
5. changes review status from `mismatch` to `reviewed` after verification and removes resolved notes;
6. keeps all npm, container, hosted, official MCP Registry, and Docker catalog distribution claims
   omitted; and
7. runs `npm run catalog:generate`, `npm run verify`, and `npm run verify:online`, committing the
   regenerated `catalog.json`.

The application has no runtime dependency on the family registry.

## Testing and CI

Vitest covers configuration normalization, authentication, rate limiting, provider/OAuth behavior,
normalization, service guardrails, all tool schemas, OpenAPI, HTTP, stdio-compatible MCP, and
Streamable HTTP MCP. Fakes prevent default tests from calling eBay.

CI enforces lockfile installation, formatting, lint, typecheck, coverage, production build,
OpenAPI generation, official-schema `server.json` validation, container build and smoke tests,
Bicep build/lint, shell syntax, dependency audit/review, secret scanning, and CodeQL. CI does not
deploy.

## Troubleshooting

| Symptom                                | Likely cause and response                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Startup `ConfigurationError`           | Correct the named variable; common causes are short keys, partial eBay credentials, or disabled production auth. |
| `/tools` or `/mcp` returns 401         | Supply the configured `x-api-key` or bearer token.                                                               |
| eBay returns 401/403                   | Match the keyset to `EBAY_ENVIRONMENT`; production Browse access may require approval.                           |
| Listing is 404 but exists in a browser | Pass its marketplace or use the full eBay country-site URL.                                                      |
| Delivered total is missing             | eBay omitted shipping; configure buyer country and postal code.                                                  |
| Search has no sold results             | Expected: Browse search contains active listings only.                                                           |
| First Azure deployment cannot read KV  | Use `provision.sh`; do not skip its foundation, role propagation, and secret-write pass.                         |
| OpenAPI advertises localhost           | Run `deploy.sh` so it discovers the existing FQDN and sets `PUBLIC_BASE_URL`.                                    |
| First request is slow                  | A scale-to-zero cold start is expected; raise `minReplicas` only after accepting the cost.                       |

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks and [SECURITY.md](SECURITY.md) for private
vulnerability reporting. This project is available under the [MIT License](LICENSE).
