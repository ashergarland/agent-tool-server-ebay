# eBay deployment contract

The canonical public deployment declaration is
[`capability-profiles.json`](../capability-profiles.json). It implements deployment contract
version 1 for the stable capability identity
`io.github.ashergarland/agent-tool-server-ebay`.

The declaration is account-neutral. It describes reusable capability support; it is not desired
state for any operator environment. A private `deployment-instance` selects exact environment,
source, artifact, configuration, secret-store, identity, provider, and rollback references. That
private Phase B migration has not happened yet and does not belong in this repository.

## Supported profile

The single `hosted-container-provider` profile represents the current hosted deployment:

| Dimension | Selection               | Meaning                                                        |
| --------- | ----------------------- | -------------------------------------------------------------- |
| execution | `hosted`                | The service runs in managed hosted infrastructure.             |
| delivery  | `container`             | The repository Dockerfile produces the deployed artifact.      |
| access    | `authenticated-service` | Protected HTTP and MCP routes require caller authentication.   |
| workload  | `provider`              | Tool results are read from eBay through the provider adapter.  |
| provider  | `external`              | eBay credentials and provider readiness are required.          |
| mutation  | `read-only`             | Every exposed agent tool reads data and changes no eBay state. |

The Marketplace Account Deletion callback does not make this a mutating profile. It is
provider-required compliance infrastructure, is not exposed as an agent tool, authenticates
notifications before handling them, and currently has no consequential domain deletion to perform
because the service stores no eBay user data. The declaration therefore omits the contract's
mutation block entirely.

## Reusable public requirements

- `Dockerfile` builds the container and runs `dist/index.js` over HTTP.
- `infra/main.bicep`, `scripts/bootstrap/provision.sh`, and `scripts/bootstrap/deploy.sh` remain the
  capability-owned deployment mechanics.
- The parameters declared by `infra/main.bicep` are the bounded public non-secret configuration
  interface. Real deployments must continue to supply an explicit operator-owned parameter file.
- The required secret names are `connector-api-key`, `ebay-client-id`, `ebay-client-secret`, and
  `ebay-account-deletion-token`. Their values belong only in the selected external secret store.
- Provider prerequisites are an eBay developer keyset, applicable Browse API access or approval,
  and Marketplace Account Deletion/Closure compliance for production keysets.
- The hosted workload identity may pull its selected image and read its declared secret references.
  eBay access uses the separately selected application credentials and remains limited to the
  documented read-only Browse and Notification public-key operations.
- Provider data is request-scoped and is not persisted. Failure to authenticate to or read from
  eBay makes provider-backed behavior unavailable even when the process itself remains healthy.

No eBay-specific extension schema is needed; the common version-1 contract expresses the current
profile completely.

## Verification surfaces

The declaration supports all six common verification surfaces:

- **identity:** protected routes reject unauthenticated callers and accept the selected caller
  identity;
- **readiness:** `/health` establishes process readiness;
- **version:** `/version` reports service and source identity;
- **behavior:** authenticated read-only tool calls satisfy their public schemas;
- **provider:** a separate authenticated eBay API smoke check establishes provider readiness;
- **provenance:** immutable container evidence binds a produced digest to the selected source.

Provider verification is deliberately separate from `/health`: the process can be live while eBay
credentials, OAuth, provider approval, or the upstream API are unavailable.

## Public and private revision independence

A private deployment instance pins the public declaration and deployed source independently:

```text
declaration.repository + declaration.revision + declaration.path
source.repository      + source.revision      + source.path
```

Adopting a newer declaration revision does not select or deploy a newer production source revision.
The eventual private Phase B descriptor must pin the full merged public declaration commit, not a
local candidate commit from this phase.

## Validate from the exact Platform source

The shared Platform implementation is authoritative for common deployment-contract semantics.
eBay owns only the capability-specific content above. The D3 adoption proof is pinned to:

```text
98ec8162fb11d5c04aee9e6f7b3625a472a0180d
```

Using Node 22:

```bash
git clone https://github.com/ashergarland/agent-tool-platform.git
cd agent-tool-platform
git checkout --detach 98ec8162fb11d5c04aee9e6f7b3625a472a0180d
test "$(git rev-parse HEAD)" = "98ec8162fb11d5c04aee9e6f7b3625a472a0180d"
npm ci
npm run build

cd /path/to/agent-tool-server-ebay
AGENT_TOOL_PLATFORM_CHECKOUT=/path/to/agent-tool-platform npm run deployment:validate
```

The thin repository command verifies the checkout SHA, invokes
`packages/runtime/bin/validate-deployment.js`, validates the canonical declaration and the visibly
synthetic fixture, and proves representative invalid documents fail. It does not copy or
reimplement Platform validation rules.

The fixture at
[`tests/fixtures/deployment/synthetic-hosted-container-provider.deployment.json`](../tests/fixtures/deployment/synthetic-hosted-container-provider.deployment.json)
is test-only. Its environment, references, and full Git revisions are deliberately synthetic and
must never be used as live desired state.
