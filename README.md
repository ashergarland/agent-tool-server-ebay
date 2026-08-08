# chatgpt-ebay

A backend-only **ChatGPT connector for eBay**. It exposes a small, typed tool surface that lets
ChatGPT retrieve the _actual_ eBay listing behind a URL through the official **eBay Browse API**,
search the live market, assemble comparables and diff several listings side by side — so the model
reasons about buy/bid decisions from real, structured evidence instead of scraped web pages.

The connector supplies data. It never recommends whether to buy or bid.

There is no frontend. The service is an HTTP/OpenAPI tool server (plus an MCP transport over the
same tool registry). It is the sibling of
[`chatgpt-azure`](https://github.com/ashergarland/chatgpt-azure) and deliberately mirrors its
architecture.

```
ChatGPT
   │  authenticated tool request
   ▼
chatgpt-ebay  ── transport (HTTP/OpenAPI today, MCP over the same registry)
   │           ── tool registry (Zod-validated input/output)
   │           ── service layer (listings / comparison + guardrails)
   ▼
eBay provider adapter
   │  OAuth client credentials (cached application token)
   ▼
eBay Browse API
```

---

## Design

| Layer     | Location                | Responsibility                                                                                                        |
| --------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Transport | `src/server`, `src/mcp` | HTTP routing, auth, rate limiting, error mapping. No eBay knowledge.                                                  |
| Tools     | `src/tools`             | Declarative tool definitions with Zod schemas; a registry that validates input and erases types for transports.       |
| Services  | `src/services`          | Business logic and guardrails: listing retrieval, search, comparables, comparison.                                    |
| Provider  | `src/provider`          | The `EbayProvider` port and its Browse API implementation. The only layer that knows about eBay wire formats.         |
| Config    | `src/config`            | Zod-validated environment; the process fails fast on misconfiguration.                                                |
| OpenAPI   | `src/openapi`           | Generates the OpenAPI 3.1 document from the tool registry, so the HTTP surface can never drift from the tool surface. |

Two rules keep the design honest:

1. **Provider logic never lives in a transport.** Adding MCP required no changes to any service.
2. **Everything below the transport throws `AppError`.** Both transports map that taxonomy to their
   own error representation in exactly one place.

---

## Tools

All four tools are read-only (`readOnlyHint` over MCP, `x-openai-isConsequential: false` in
OpenAPI). Nothing in this connector changes state on eBay.

| Tool                         | Purpose                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `ebay_get_listing`           | One listing by URL, numeric item id or Browse item id, fully normalised.                     |
| `ebay_search_listings`       | Structured keyword/filter search over active listings.                                       |
| `ebay_find_similar_listings` | Comparables for a given listing, using EPID/GTIN/MPN when eBay has them, keywords otherwise. |
| `ebay_compare_listings`      | Two or more listings side by side plus a plain-language diff.                                |

### `ebay_get_listing`

Returns item id and legacy item id, title, subtitle, canonical URL, marketplace, price, current bid
and bid count, Buy It Now and Best Offer availability, shipping options and lowest shipping cost,
the estimated delivered total (only when shipping is actually known — see below), buying format,
auction start/end and seconds remaining, whether the listing is still active, condition, condition
id and the seller's condition description, seller username, feedback percentage and score, item and
seller location, return policy, quantity and availability, category path, localized aspects (item
specifics), catalogue identifiers (EPID/GTIN/MPN/brand), images, and any warnings eBay returned.

`estimatedDeliveredTotal` is **omitted rather than guessed** when eBay does not report a shipping
cost. A bare item price is never presented as a delivered total. Calculated-shipping listings only
return `shippingOptions` when a buyer context is supplied, so setting `EBAY_DELIVERY_COUNTRY` and
`EBAY_DELIVERY_POSTAL_CODE` materially improves delivered-total coverage.

### Listing URL and item id handling

`src/provider/ebay/urls.ts` accepts, and `tests/unit/urls.test.ts` exercises:

- `https://www.ebay.com/itm/407111131587`
- `https://www.ebay.com/itm/<seo-slug>/407111131587`
- Query strings and tracking parameters (`?hash=item...&var=...&_trkparms=...`)
- `m.ebay.com`, `www.ebay.co.uk`, `ebay.de`, `ebay.com.au` and the other supported country hosts,
  each mapped to its Browse marketplace id (`EBAY_GB`, `EBAY_DE`, `EBAY_AU`, …)
- Legacy `cgi.ebay.*/ws/eBayISAPI.dll?ViewItem&item=<id>` links
- Bare numeric item ids (`407111131587`)
- Browse API item ids (`v1|407111131587|0`, including a non-zero variation id)
- `/p/<epid>` **product** pages, which are recognised and rejected with a clear `bad_request`
  naming the EPID, because a product page is a catalogue entry rather than a listing

Parsing uses `URL` plus targeted anchored regexes — never string splitting. Hostname → marketplace
resolution walks labels inwards from the full host, so `ebay.com.au` wins over `ebay.com` and
hostile lookalikes such as `notebay.com` or `ebay.com.evil.example` never match. Anything else
raises a `bad_request` `AppError` explaining what forms are accepted.

---

## Sold and completed listings — what this connector cannot do

This is the single most important capability limit, and it is stated in the OpenAPI description
too so the model sees it:

> **The connector returns active listings only. It cannot retrieve sold or completed prices.**

Why:

- The **Browse API** — the API this connector is built on — indexes items that are currently
  available for purchase. There is no sold/ended search in it.
- eBay's **Marketplace Insights API**, which does expose sold/completed items (last 90 days), is a
  **Limited Release** API. Access requires an application to, and approval from, the eBay Partner
  Network / eBay business team. A standard developer account does not have it. Implementing it
  speculatively would produce a tool that returns `403` for almost every user, so it is
  deliberately not implemented.
- The old Finding API `findCompletedItems` operation is retired and is not a compliant option.
- Scraping eBay's "sold items" search results is against eBay's terms and is explicitly out of
  scope for this connector.

What you get instead: `ebay_search_listings` and `ebay_find_similar_listings` describe the **live
asking market**. Every result is flagged `active`, and `activeOnly: true` is returned alongside so
that ChatGPT cannot mistake asking prices for realised prices. In practice, for the categories this
connector targets (retro consoles, games, electronics, physical media, collectibles), the active
market plus auction bid counts and end times is a solid evidence base — it is just not the same as
sold comps, and the connector says so.

If you are later granted Marketplace Insights access, the clean place to add it is a new method on
the `EbayProvider` port plus a new tool definition; no transport changes would be needed.

**Production access note:** eBay documents production Buy API access (including Browse) as being
for approved eBay partners. The sandbox is open to any developer account. If your production keyset
is not enabled for Browse, set `EBAY_ENVIRONMENT=sandbox` — the connector is otherwise identical.

---

## eBay developer setup

1. Create an account at <https://developer.ebay.com> and open **Application Keysets**.
2. Note the **App ID (Client ID)** and **Cert ID (Client Secret)** for the keyset you intend to
   use. These map to `EBAY_CLIENT_ID` and `EBAY_CLIENT_SECRET`.
3. Choose the environment: the sandbox keyset with `EBAY_ENVIRONMENT=sandbox`, or the production
   keyset with `EBAY_ENVIRONMENT=production`.
4. No user consent flow or redirect URI is needed — the connector only reads public listing data,
   which uses the **client credentials** grant.

### OAuth flow

The connector uses the **application access token** (client credentials) grant, which is the
correct flow for public Browse data:

```
POST https://api.ebay.com/identity/v1/oauth2/token      (sandbox: api.sandbox.ebay.com)
Authorization: Basic base64(<client-id>:<client-secret>)
Content-Type:  application/x-www-form-urlencoded

grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope
```

`src/provider/ebay/oauth.ts` implements this with:

- **In-memory caching.** eBay tokens live 7200 seconds and eBay explicitly asks callers to reuse
  them. A token is never fetched per request.
- **Refresh before expiry.** The cached token is considered stale `EBAY_TOKEN_REFRESH_SKEW_MS`
  (default 5 minutes) before its real expiry.
- **In-flight collapsing.** Concurrent requests that arrive during a refresh share one token call.
- **Invalidation on `401`.** A rejected token is dropped and the request is retried once with a
  fresh one, which covers a token revoked early by eBay.
- **No secret logging, ever.** Credentials, the `Authorization` header and the token itself are
  never written to the log, including in error paths. There is a test asserting this.

Retries use exponential backoff with jitter for `429` and `5xx`, honouring `Retry-After` when eBay
sends it, bounded by `EBAY_MAX_RETRIES`.

### Browse API usage

| Purpose            | Endpoint                                        |
| ------------------ | ----------------------------------------------- |
| Item by Browse id  | `GET /buy/browse/v1/item/{item_id}`             |
| Item by numeric id | `GET /buy/browse/v1/item/get_item_by_legacy_id` |
| Search             | `GET /buy/browse/v1/item_summary/search`        |

Every call sends `X-EBAY-C-MARKETPLACE-ID`. When a buyer context is configured the connector also
sends `X-EBAY-C-ENDUSERCTX` with `contextualLocation`, which is what makes eBay return
`shippingOptions` for calculated-shipping listings. `fieldgroups=PRODUCT` is requested on item
fetches so EPID/GTIN/MPN are available to drive comparables.

Search filters are built in `src/provider/ebay/filters.ts` against eBay's documented filter syntax
(`name:value`, sets `{A|B}`, ranges `[min..max]`). Notable eBay constraints the code respects:
`price` requires `priceCurrency`; `maxDeliveryCost` only accepts `0`; `returnsAccepted` only
accepts `true`; `conditions` only accepts `NEW`/`USED`, so granular condition filtering goes
through `conditionIds`. Only the sort values eBay documents (`price`, `-price`, `newlyListed`, and
Best Match by omission) are exposed.

---

## HTTP API

| Method | Path                | Auth | Description                                     |
| ------ | ------------------- | ---- | ----------------------------------------------- |
| `GET`  | `/health`           | no   | Liveness probe.                                 |
| `GET`  | `/version`          | no   | Build metadata and effective capabilities.      |
| `GET`  | `/openapi.json`     | no   | OpenAPI 3.1 document for the ChatGPT connector. |
| `GET`  | `/tools`            | yes  | Tool catalogue with JSON Schemas.               |
| `POST` | `/tools/{toolName}` | yes  | Invoke a tool.                                  |

Tool input may be sent either bare or wrapped in an `input` envelope:

```bash
curl -sS "https://<host>/tools/ebay_get_listing" \
  -H "x-api-key: <connector-api-key>" \
  -H 'content-type: application/json' \
  -d '{"item":"https://www.ebay.com/itm/407111131587"}'
```

The `authorization` request header with a bearer token is accepted as an equivalent to
`x-api-key`, which is what the ChatGPT connector UI sends.

Successful responses are `{ "tool", "requestId", "result" }`. Failures use a single envelope:

```json
{
  "error": {
    "code": "bad_request",
    "message": "\"https://www.ebay.com/p/1234567\" is an eBay product page, not a listing",
    "details": { "epid": "1234567" },
    "retryable": false,
    "requestId": "9f1c..."
  }
}
```

Codes map to HTTP status: `bad_request` 400, `unauthorized` 401, `forbidden` 403, `not_found` 404,
`conflict` 409, `rate_limited` 429, `internal_error` 500, `upstream_error` 502, `timeout` 504.

---

## Authentication

Inbound (ChatGPT → connector) authentication is **completely independent** of the eBay credentials.
The eBay application credentials are never accepted as, or used as, a caller credential.

- `AUTH_MODE=api-key` (default). Keys come from `API_KEYS`, comma separated, each at least 32
  characters, compared in **constant time** against both `x-api-key` and `authorization: Bearer`.
- `AUTH_MODE=disabled` is for local development only and is **rejected at startup** when
  `NODE_ENV=production`.
- Rate limiting is a fixed window per authenticated principal (`RATE_LIMIT_MAX` /
  `RATE_LIMIT_WINDOW_MS`), with a more generous pre-auth limit per address so an unauthenticated
  flood cannot force unbounded credential verification.

---

## Configuration

All configuration is environment based and validated at startup — see `.env.example` for the
annotated list.

| Variable                                              | Default                                | Notes                                                                          |
| ----------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------ |
| `PORT` / `HOST`                                       | `8080` / `0.0.0.0`                     | HTTP listener.                                                                 |
| `LOG_LEVEL`                                           | `info`                                 | pino level.                                                                    |
| `PUBLIC_BASE_URL`                                     | –                                      | Server URL advertised in the OpenAPI document.                                 |
| `AUTH_MODE`                                           | `api-key`                              | `api-key` or `disabled` (rejected in production).                              |
| `API_KEYS`                                            | –                                      | Comma-separated keys, each at least 32 characters. Compared in constant time.  |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET`               | –                                      | eBay App ID / Cert ID. Required together; required when `NODE_ENV=production`. |
| `EBAY_ENVIRONMENT`                                    | `production`                           | `production` or `sandbox`.                                                     |
| `EBAY_MARKETPLACE_ID`                                 | `EBAY_US`                              | Default marketplace when a tool call does not imply one.                       |
| `EBAY_OAUTH_SCOPES`                                   | `https://api.ebay.com/oauth/api_scope` | Comma-separated OAuth scopes.                                                  |
| `EBAY_TOKEN_REFRESH_SKEW_MS`                          | `300000`                               | Renew the cached token this long before expiry.                                |
| `EBAY_MAX_RETRIES` / `EBAY_RETRY_BASE_DELAY_MS`       | `2` / `250`                            | Backoff for `429`/`5xx`.                                                       |
| `EBAY_DELIVERY_COUNTRY` / `EBAY_DELIVERY_POSTAL_CODE` | –                                      | Buyer context; greatly improves shipping and delivered-total coverage.         |
| `EBAY_AFFILIATE_CAMPAIGN_ID`                          | –                                      | eBay Partner Network campaign id; returns affiliate item URLs when set.        |
| `EBAY_SEARCH_DEFAULT_LIMIT` / `EBAY_SEARCH_MAX_LIMIT` | `20` / `50`                            | Result-size guardrails.                                                        |
| `EBAY_COMPARE_MAX_ITEMS`                              | `8`                                    | Maximum listings per comparison.                                               |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`             | `120` / `60000`                        | Per-principal fixed window; `0` disables.                                      |
| `REQUEST_TIMEOUT_MS`                                  | `30000`                                | Upstream eBay timeout.                                                         |

Supported marketplaces are the 16 the Buy APIs actually support: `EBAY_AT`, `EBAY_AU`, `EBAY_BE`,
`EBAY_CA`, `EBAY_CH`, `EBAY_DE`, `EBAY_ES`, `EBAY_FR`, `EBAY_GB`, `EBAY_HK`, `EBAY_IE`, `EBAY_IT`,
`EBAY_NL`, `EBAY_PL`, `EBAY_SG`, `EBAY_US`.

---

## Local development

Requires Node.js 22+.

```bash
npm install
cp .env.example .env          # then edit
npm run dev
```

You can run the whole test suite and the server without eBay credentials (`AUTH_MODE=disabled`,
no `EBAY_*` keys) — tool calls will then fail with a clear `internal_error` explaining that eBay
credentials are not configured, but every non-eBay path works.

Useful scripts:

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint (type-aware)
npm run format        # prettier
npm test              # vitest
npm run test:coverage # vitest + v8 coverage
npm run build         # tsc -> dist/
npm start             # run the built server
npm run openapi:emit  # print the OpenAPI document (optionally to a file)
npm run mcp:stdio     # run the same tools over MCP stdio
```

Docker:

```bash
docker build -t chatgpt-ebay .
docker run --rm -p 8080:8080 \
  -e API_KEYS="$(openssl rand -hex 32)" \
  -e EBAY_CLIENT_ID="..." \
  -e EBAY_CLIENT_SECRET="..." \
  chatgpt-ebay
```

---

## Testing

```bash
npm test
```

The suite **never requires live eBay credentials**. The provider is exercised through a scripted
`fetch` double (`tests/helpers/fake-fetch.ts`) and the services through a fake provider
(`tests/helpers/fake-provider.ts`), so tests are hermetic and make no network calls.

Coverage includes: eBay URL and item-id parsing (a large dedicated suite), marketplace resolution,
config validation, auth middleware and constant-time key comparison, rate limiting, tool input
validation, output-schema round-tripping for every tool, OAuth token caching / expiry / refresh /
invalidation / concurrency, provider error mapping and retry behaviour, price and shipping
normalisation, active vs ended listing behaviour, comparable-strategy selection, error
normalisation, the health/version/openapi endpoints, the full HTTP tool surface, and the MCP
transport.

Live tests are opt-in and skipped by default:

```bash
EBAY_LIVE_TESTS=1 EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... npm test
```

---

## MCP

The same registry is served over MCP, so a local MCP client can use the identical tools:

```bash
npm run build && npm run mcp:stdio
```

All tools are annotated `readOnlyHint: true` and `destructiveHint: false`. The MCP adapter contains
no eBay logic whatsoever — it maps the registry to MCP's tool protocol and maps `AppError` to an
MCP tool error, which is the only place that mapping exists for this transport.

---

## Deploying to Azure

Infrastructure lives in `infra/` (Bicep, subscription-scoped) and provisions a user-assigned
managed identity, an Azure Container Registry, a Key Vault holding the connector API key **and the
eBay application credentials**, a Log Analytics workspace, and a Container App running the
connector with the identity attached.

The identity is deliberately minimal: `AcrPull` on its own registry and `Key Vault Secrets User` on
its own vault. It gets **no** subscription Reader or Contributor role — the connector talks to
eBay, not to Azure.

```bash
# 1. Provision infrastructure, generate the connector API key, seed the eBay secrets
EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... \
  ./scripts/bootstrap/provision.sh <subscription-id> prod westus2

# 2. Build the image in ACR and redeploy the Container App
./scripts/bootstrap/deploy.sh <subscription-id> prod westus2
```

`provision.sh` deploys in two passes on purpose. The Container App mounts all three secrets below
directly out of Key Vault, so it cannot be created before they exist; the first pass runs with
`deployApp=false` to create the vault and the identity, the script seeds the secrets, and the
second pass brings the app up. Collapsing this back into a single deployment will fail on a clean
subscription with `unable to fetch secret 'connector-api-key'`.

The script also grants the invoking user **Key Vault Secrets Officer** on the vault and waits for
the assignment to propagate. The vault sets `enableRbacAuthorization: true`, so being subscription
Owner does **not** by itself grant the data-plane access needed to write a secret.

> Note that CI validates the Bicep with `az bicep build` and the linter, which checks syntax and
> never attempts a deployment. Green CI does not prove the templates deploy.

Secrets in Key Vault, surfaced to the Container App as secret references:

| Key Vault secret     | Container App env var |
| -------------------- | --------------------- |
| `connector-api-key`  | `API_KEYS`            |
| `ebay-client-id`     | `EBAY_CLIENT_ID`      |
| `ebay-client-secret` | `EBAY_CLIENT_SECRET`  |

To rotate a credential, set a new value in Key Vault and restart the Container App revision.

Optional settings (`publicBaseUrl`, `ebayDeliveryCountry`, `ebayDeliveryPostalCode`) are omitted
from the container's environment entirely when empty rather than passed as empty strings, and the
config loader treats a blank value as "not set". Both halves matter: the first provisioning pass
has no public URL to supply yet, and a strict `z.url()` against `''` would otherwise crash the
container at startup with `PUBLIC_BASE_URL: Invalid URL` before it ever became healthy.

### GitHub OIDC

For CI-driven deployment, federate a GitHub Actions identity instead of storing a client secret:

```bash
az ad app create --display-name chatgpt-ebay-deploy
# then add a federated credential for this repository, e.g.
#   subject: repo:ashergarland/chatgpt-ebay:ref:refs/heads/main
#   issuer:  https://token.actions.githubusercontent.com
#   audience: api://AzureADTokenExchange
```

Grant that principal `Contributor` on the connector resource group only, and use
`azure/login@v2` with `client-id` / `tenant-id` / `subscription-id` and no secret. The CI workflow
in this repository intentionally only builds and validates; it does not deploy.

### Registering the connector in ChatGPT

1. Retrieve the connector API key from Key Vault
   (`az keyvault secret show --vault-name <kv> --name connector-api-key --query value -o tsv`).
2. Point ChatGPT at `https://<connector-host>/openapi.json`.
3. Configure authentication as a bearer token using that key.

---

## Troubleshooting

| Symptom                                                                                                           | Likely cause and fix                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Startup fails with `ConfigurationError`                                                                           | The message names the offending variable. Common cases: `API_KEYS` shorter than 32 chars, only one of the eBay credentials set, `AUTH_MODE=disabled` with `NODE_ENV=production`.                                                            |
| First `provision.sh` run fails with `Unable to get value using Managed identity ... for secret connector-api-key` | The Container App was deployed before its Key Vault secrets existed. Provisioning is deliberately two passes — do not collapse it into one, and do not deploy `main.bicep` by hand on a clean subscription without `deployApp=false` first. |
| `az keyvault secret set` returns 403 for a subscription Owner                                                     | The vault uses RBAC authorisation, which is separate from control-plane roles. Grant yourself **Key Vault Secrets Officer** on the vault and allow ~45s to propagate; `provision.sh` does this automatically.                               |
| Container App revision never becomes healthy                                                                      | Check the console logs for a `ConfigurationError` — the environment is validated at startup and the message names the offending variable.                                                                                                   |
| `401 unauthorized` on `/tools`                                                                                    | Missing or wrong `x-api-key` / bearer token. `/health` and `/openapi.json` are unauthenticated by design.                                                                                                                                   |
| `502 upstream_error` mentioning invalid client                                                                    | eBay rejected the credentials. Check you are using the keyset that matches `EBAY_ENVIRONMENT`.                                                                                                                                              |
| `403` from eBay in production                                                                                     | Your production keyset is probably not enabled for the Buy/Browse APIs. Use `EBAY_ENVIRONMENT=sandbox` until it is approved.                                                                                                                |
| `404 not_found` for a listing that exists in a browser                                                            | Wrong marketplace. Pass `marketplaceId`, or use the full listing URL so the host implies it.                                                                                                                                                |
| `bad_request` about a product page                                                                                | The URL is a `/p/<epid>` catalogue page. Open the actual listing and use its `/itm/` URL.                                                                                                                                                   |
| `estimatedDeliveredTotal` missing                                                                                 | eBay did not report a shipping cost. Set `EBAY_DELIVERY_COUNTRY` / `EBAY_DELIVERY_POSTAL_CODE` to enable calculated shipping quotes.                                                                                                        |
| `429 rate_limited`                                                                                                | Either the connector's own per-principal limit or eBay's. The error envelope says which; `retryable` is `true`.                                                                                                                             |
| Empty `comparables`                                                                                               | The source listing had no catalogue identifiers and its keywords were too specific. Check the returned `strategy` and `notes`.                                                                                                              |

---

## Security considerations

- **Credential separation.** The ChatGPT-facing API key and the eBay application credentials are
  distinct, live in distinct Key Vault secrets, and are never interchangeable.
- **No secret logging.** Tokens, client secrets and `Authorization` headers are never logged. Error
  paths log the eBay `errorId`/category, not the request headers.
- **Constant-time key comparison** avoids leaking key material through response timing.
- **Fail-fast configuration.** A misconfigured deployment refuses to start rather than running with
  authentication silently disabled.
- **Sanitised errors in production.** Unexpected internal errors are reduced to a generic message
  when `NODE_ENV=production`; the detail stays in the logs with the request id.
- **Bounded input and output.** Body size, string lengths, array sizes, search limits, comparison
  counts, image counts and item-specific counts are all capped, so neither a hostile caller nor an
  unusually large eBay payload can blow up a model context.
- **Read-only by construction.** The connector calls only `GET` Browse endpoints. There is no code
  path that can buy, bid, list or message on eBay.
- **Minimal cloud privilege.** The Azure identity can pull its image and read its own secrets, and
  nothing else.

---

## Repository layout

```
src/
  app.ts                 composition root
  index.ts               HTTP entry point
  errors.ts              transport-agnostic error taxonomy
  config/                Zod-validated environment
  server/                Fastify transport, auth, rate limiting, error mapping
  tools/                 tool definitions + registry
  services/              listings, comparison, keyword derivation, guardrails
  provider/              EbayProvider port + Browse API adapter
    ebay/                oauth, rest, urls, filters, marketplaces, normalize
  openapi/               OpenAPI 3.1 generation
  mcp/                   MCP server + stdio entry point
  util/                  logging, type helpers
infra/                   Bicep templates, modules and parameter files
scripts/bootstrap/       provisioning and deployment scripts
tests/                   unit and integration tests
```
