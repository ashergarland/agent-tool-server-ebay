#!/usr/bin/env bash
#
# Hermetic behavioural checks for scripts/bootstrap/common.sh.
#
# The static assertions in tests/unit/deployment-parameters.test.ts prove the scripts *reference* a
# resolved parameter file. This proves the shared behaviour itself: parameter resolution finds the
# committed portable baseline, layers an operator overlay, honours an explicit authoritative file,
# and aborts on a missing one; and `ensure_secret` writes only when a Key Vault secret is genuinely
# absent.
#
# Makes no Azure calls; the `az` CLI is stubbed. Run with: ./scripts/verify-parameter-resolution.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/bootstrap/common.sh
source "${REPO_ROOT}/scripts/bootstrap/common.sh"

failures=0

assert_equals() {
  local label="$1" expected="$2" actual="$3"
  if [[ "${expected}" == "${actual}" ]]; then
    echo "  ok   ${label}"
  else
    echo "  FAIL ${label}" >&2
    echo "       expected: ${expected}" >&2
    echo "       actual:   ${actual}" >&2
    failures=$((failures + 1))
  fi
}

echo "==> resolves the committed environment file by default"
for environment in prod dev; do
  resolve_parameter_files "${REPO_ROOT}" "${environment}" ''
  assert_equals "${environment} base file" \
    "${REPO_ROOT}/infra/parameters/${environment}.parameters.json" "${PARAMETER_FILE}"
  assert_equals "${environment} argument list" \
    "--parameters @${REPO_ROOT}/infra/parameters/${environment}.parameters.json" \
    "${PARAMETER_ARGS[*]}"
  assert_equals "${environment} has no overlay" '' "${PARAMETER_OVERLAY}"
done

echo "==> layers a gitignored operator overlay after the committed file"
OVERLAY="${REPO_ROOT}/infra/parameters/prod.local.parameters.json"
if [[ -e "${OVERLAY}" ]]; then
  echo "  skip: ${OVERLAY} already exists; not overwriting an operator file"
else
  printf '{"parameters":{"alertEmails":{"value":[]}}}\n' >"${OVERLAY}"
  trap 'rm -f "${OVERLAY}"' EXIT
  resolve_parameter_files "${REPO_ROOT}" prod ''
  assert_equals 'overlay is applied last' \
    "--parameters @${REPO_ROOT}/infra/parameters/prod.parameters.json --parameters @${OVERLAY}" \
    "${PARAMETER_ARGS[*]}"
  assert_equals 'overlay is ignored by git' '' "$(git -C "${REPO_ROOT}" ls-files "${OVERLAY}")"
  rm -f "${OVERLAY}"
  trap - EXIT
fi

echo "==> honours an explicitly supplied parameter file"
resolve_parameter_files "${REPO_ROOT}" prod "${REPO_ROOT}/infra/parameters/dev.parameters.json"
assert_equals 'explicit file wins' \
  "${REPO_ROOT}/infra/parameters/dev.parameters.json" "${PARAMETER_FILE}"

echo "==> aborts when the parameter file is missing"
if (resolve_parameter_files "${REPO_ROOT}" nonexistent-environment '' 2>/dev/null); then
  echo "  FAIL a missing parameter file did not abort" >&2
  failures=$((failures + 1))
else
  echo "  ok   a missing parameter file aborts"
fi

# --- Key Vault stub ---------------------------------------------------------
#
# A Key Vault read can fail for reasons other than "the secret is not there": throttling, a
# transient 5xx, or missing data-plane RBAC. Treating any of those as absence would rotate a live
# connector API key or eBay verification token on the next provisioning run. These checks stub the
# `az` CLI to prove the functions only write when a secret is genuinely missing, and to prove that
# placeholder eBay credentials can never reach a production vault.
#
# The stub resolves per-secret behaviour from ${STUB_DIR}/behaviour/<secret-name>, falling back to
# AZ_SHOW_BEHAVIOUR, so a test can make one credential present and the other absent. Every write is
# logged with its value so assertions can prove exactly what would have been stored.

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "${STUB_DIR}"' EXIT
mkdir -p "${STUB_DIR}/behaviour"
cat >"${STUB_DIR}/az" <<'STUB'
#!/usr/bin/env bash
name=''
value=''
previous=''
for arg in "$@"; do
  case "${previous}" in
    --name) name="${arg}" ;;
    --value) value="${arg}" ;;
  esac
  previous="${arg}"
done

behaviour="${AZ_SHOW_BEHAVIOUR:-missing}"
if [[ -f "${AZ_BEHAVIOUR_DIR}/${name}" ]]; then
  behaviour="$(cat "${AZ_BEHAVIOUR_DIR}/${name}")"
fi

if [[ "$3" == "show" ]]; then
  case "${behaviour}" in
    found) exit 0 ;;
    missing) echo "(SecretNotFound) A secret with (name/id) ${name} was not found in this key vault." >&2; exit 1 ;;
    throttled) echo "(429) Too many requests" >&2; exit 1 ;;
    forbidden) echo "(Forbidden) Caller is not authorized to perform action on resource." >&2; exit 1 ;;
  esac
fi
if [[ "$3" == "set" ]]; then
  echo "${name}=${value}" >>"${AZ_WRITE_LOG}"
  exit 0
fi
exit 0
STUB
chmod +x "${STUB_DIR}/az"
export PATH="${STUB_DIR}:${PATH}"
export AZ_WRITE_LOG="${STUB_DIR}/writes"
export AZ_BEHAVIOUR_DIR="${STUB_DIR}/behaviour"
: >"${AZ_WRITE_LOG}"

# Declares how the stubbed vault should answer for one secret: found | missing | throttled | forbidden
set_secret_behaviour() {
  echo "$2" >"${AZ_BEHAVIOUR_DIR}/$1"
}

reset_vault() {
  rm -f "${AZ_BEHAVIOUR_DIR}"/*
  : >"${AZ_WRITE_LOG}"
  unset EBAY_CLIENT_ID EBAY_CLIENT_SECRET ALLOW_PLACEHOLDER_EBAY_CREDENTIALS
}

echo "==> ensure_secret leaves an existing secret untouched"
export AZ_SHOW_BEHAVIOUR=found
if ensure_secret vault connector-api-key new-value >/dev/null; then
  echo "  FAIL reported a write for an existing secret" >&2
  failures=$((failures + 1))
else
  assert_equals 'no write performed' '' "$(cat "${AZ_WRITE_LOG}")"
fi

echo "==> ensure_secret writes a genuinely missing secret"
export AZ_SHOW_BEHAVIOUR=missing
: >"${AZ_WRITE_LOG}"
if ensure_secret vault connector-api-key new-value >/dev/null; then
  assert_equals 'write performed' 'connector-api-key=new-value' "$(cat "${AZ_WRITE_LOG}")"
else
  echo "  FAIL did not write a missing secret" >&2
  failures=$((failures + 1))
fi

for behaviour in throttled forbidden; do
  echo "==> ensure_secret refuses to write when the read fails with ${behaviour}"
  : >"${AZ_WRITE_LOG}"
  export AZ_SHOW_BEHAVIOUR="${behaviour}"
  # Run in a subshell: the function aborts the script rather than returning on this path.
  if (ensure_secret vault connector-api-key new-value >/dev/null 2>&1); then
    echo "  FAIL a ${behaviour} read was treated as success" >&2
    failures=$((failures + 1))
  else
    assert_equals "no write after a ${behaviour} read" '' "$(cat "${AZ_WRITE_LOG}")"
  fi
done

# --- eBay credential bootstrap ----------------------------------------------
#
# Provisioning used to write REPLACE_WITH_EBAY_APP_ID / REPLACE_WITH_EBAY_CERT_ID whenever the
# environment variables were absent. Because an existing secret is deliberately never overwritten,
# that placeholder then survived every later run: every eBay call failed against a value nothing in
# the system could tell was fake. These checks prove that can no longer happen in production.

export AZ_SHOW_BEHAVIOUR=missing

echo "==> targets_ebay_production classifies deployments correctly"
if targets_ebay_production prod "${REPO_ROOT}/infra/parameters/prod.parameters.json"; then
  echo "  ok   prod + production parameter file is a production target"
else
  echo "  FAIL prod was not treated as production" >&2
  failures=$((failures + 1))
fi
if targets_ebay_production dev "${REPO_ROOT}/infra/parameters/dev.parameters.json"; then
  echo "  FAIL dev + sandbox parameter file was treated as production" >&2
  failures=$((failures + 1))
else
  echo "  ok   dev + sandbox parameter file is not a production target"
fi
# An environment named something other than prod must not opt out of the check while still
# pointing at the production eBay keyset.
if targets_ebay_production staging "${REPO_ROOT}/infra/parameters/prod.parameters.json"; then
  echo "  ok   a non-prod name still counts as production when the keyset is production"
else
  echo "  FAIL a production keyset escaped the check via its environment name" >&2
  failures=$((failures + 1))
fi
# Case must not be a way out either: "PROD" with a sandbox parameter file would otherwise be
# classified by the file alone.
if targets_ebay_production PROD "${REPO_ROOT}/infra/parameters/dev.parameters.json"; then
  echo "  ok   an upper-case environment name is still production"
else
  echo "  FAIL an upper-case environment name escaped the name check" >&2
  failures=$((failures + 1))
fi
if targets_ebay_production staging "${STUB_DIR}/does-not-exist.json"; then
  echo "  ok   an unreadable parameter file fails safe as production"
else
  echo "  FAIL an unreadable parameter file did not fail safe" >&2
  failures=$((failures + 1))
fi
# A malformed or incomplete parameter file must also fail safe rather than silently allowing
# placeholders into what may well be a production vault.
printf 'not json' >"${STUB_DIR}/malformed.json"
if targets_ebay_production staging "${STUB_DIR}/malformed.json"; then
  echo "  ok   a malformed parameter file fails safe as production"
else
  echo "  FAIL a malformed parameter file did not fail safe" >&2
  failures=$((failures + 1))
fi
# The operator overlay is layered last and therefore wins at deploy time. A sandbox base that an
# overlay flips to the production keyset must be classified as production, or that deployment
# would be eligible for placeholder credentials against the real eBay keyset.
printf '{"parameters":{"ebayEnvironment":{"value":"production"}}}' >"${STUB_DIR}/overlay-prod.json"
if targets_ebay_production staging "${REPO_ROOT}/infra/parameters/dev.parameters.json" \
  "${STUB_DIR}/overlay-prod.json"; then
  echo "  ok   an overlay that selects the production keyset wins"
else
  echo "  FAIL an overlay selecting production was ignored" >&2
  failures=$((failures + 1))
fi
# An empty overlay argument is the normal case and must not change the verdict.
if targets_ebay_production staging "${REPO_ROOT}/infra/parameters/dev.parameters.json" ''; then
  echo "  FAIL an empty overlay argument was treated as production" >&2
  failures=$((failures + 1))
else
  echo "  ok   an empty overlay argument leaves a sandbox target alone"
fi
# Degenerate case: a caller that supplies no usable file learns nothing, and must not conclude
# "sandbox". Unreachable from provision.sh today; asserted so a future caller cannot fail open.
if targets_ebay_production staging '' ''; then
  echo "  ok   supplying no usable parameter file fails safe as production"
else
  echo "  FAIL no usable parameter file was treated as sandbox" >&2
  failures=$((failures + 1))
fi

echo "==> existing production credentials are preserved without any environment variable"
reset_vault
set_secret_behaviour ebay-client-id found
set_secret_behaviour ebay-client-secret found
if (assert_ebay_credentials_available vault true >/dev/null 2>&1); then
  assert_equals 'no write attempted' '' "$(cat "${AZ_WRITE_LOG}")"
  ensure_ebay_credential vault ebay-client-id EBAY_CLIENT_ID REPLACE_WITH_EBAY_APP_ID >/dev/null
  assert_equals 'existing secret left untouched' '' "$(cat "${AZ_WRITE_LOG}")"
else
  echo "  FAIL aborted even though both credentials already existed" >&2
  failures=$((failures + 1))
fi

for missing_secret in ebay-client-id ebay-client-secret; do
  echo "==> production aborts when ${missing_secret} is absent and its variable is unset"
  reset_vault
  set_secret_behaviour ebay-client-id found
  set_secret_behaviour ebay-client-secret found
  set_secret_behaviour "${missing_secret}" missing
  if (assert_ebay_credentials_available vault true >/dev/null 2>&1); then
    echo "  FAIL production provisioning continued without ${missing_secret}" >&2
    failures=$((failures + 1))
  else
    assert_equals "nothing written for ${missing_secret}" '' "$(cat "${AZ_WRITE_LOG}")"
  fi
done

echo "==> production refuses a placeholder even when explicitly opted in"
reset_vault
set_secret_behaviour ebay-client-id missing
set_secret_behaviour ebay-client-secret missing
export ALLOW_PLACEHOLDER_EBAY_CREDENTIALS=1
if (assert_ebay_credentials_available vault true >/dev/null 2>&1); then
  echo "  FAIL the opt-in overrode the production guard" >&2
  failures=$((failures + 1))
else
  assert_equals 'nothing written' '' "$(cat "${AZ_WRITE_LOG}")"
fi
unset ALLOW_PLACEHOLDER_EBAY_CREDENTIALS

echo "==> supplied production credentials are written exactly once"
reset_vault
set_secret_behaviour ebay-client-id missing
set_secret_behaviour ebay-client-secret missing
export EBAY_CLIENT_ID='supplied-app-id'
export EBAY_CLIENT_SECRET='supplied-cert-id'
if (
  assert_ebay_credentials_available vault true >/dev/null 2>&1
  ensure_ebay_credential vault ebay-client-id EBAY_CLIENT_ID REPLACE_WITH_EBAY_APP_ID >/dev/null
  ensure_ebay_credential vault ebay-client-secret EBAY_CLIENT_SECRET REPLACE_WITH_EBAY_CERT_ID >/dev/null
); then
  assert_equals 'both credentials written once, with the supplied values' \
    'ebay-client-id=supplied-app-id ebay-client-secret=supplied-cert-id' \
    "$(tr '\n' ' ' <"${AZ_WRITE_LOG}" | sed 's/ *$//')"
else
  echo "  FAIL supplied production credentials were rejected" >&2
  failures=$((failures + 1))
fi
reset_vault

echo "==> no placeholder value can reach a production vault"
for scenario in 'no-vars' 'partial-vars' 'opted-in'; do
  reset_vault
  set_secret_behaviour ebay-client-id missing
  set_secret_behaviour ebay-client-secret missing
  case "${scenario}" in
    partial-vars) export EBAY_CLIENT_ID='only-the-id' ;;
    opted-in) export ALLOW_PLACEHOLDER_EBAY_CREDENTIALS=1 ;;
  esac
  (assert_ebay_credentials_available vault true >/dev/null 2>&1) || true
  if grep -q 'REPLACE_WITH' "${AZ_WRITE_LOG}" 2>/dev/null; then
    echo "  FAIL a placeholder was written in the ${scenario} scenario" >&2
    failures=$((failures + 1))
  else
    echo "  ok   ${scenario}: no placeholder written"
  fi
done
reset_vault

echo "==> a transient production read aborts instead of writing a placeholder"
for behaviour in throttled forbidden; do
  reset_vault
  set_secret_behaviour ebay-client-id "${behaviour}"
  set_secret_behaviour ebay-client-secret "${behaviour}"
  if (assert_ebay_credentials_available vault true >/dev/null 2>&1); then
    echo "  FAIL a ${behaviour} read was treated as an existing credential" >&2
    failures=$((failures + 1))
  else
    assert_equals "nothing written after a ${behaviour} read" '' "$(cat "${AZ_WRITE_LOG}")"
  fi
done

echo "==> non-production still requires credentials unless placeholders are opted into"
reset_vault
set_secret_behaviour ebay-client-id missing
set_secret_behaviour ebay-client-secret missing
if (assert_ebay_credentials_available vault false >/dev/null 2>&1); then
  echo "  FAIL non-production silently accepted missing credentials" >&2
  failures=$((failures + 1))
else
  echo "  ok   non-production aborts without an explicit opt-in"
fi

echo "==> non-production placeholders remain available behind an explicit opt-in"
reset_vault
set_secret_behaviour ebay-client-id missing
set_secret_behaviour ebay-client-secret missing
export ALLOW_PLACEHOLDER_EBAY_CREDENTIALS=1
if (
  assert_ebay_credentials_available vault false >/dev/null 2>&1
  ensure_ebay_credential vault ebay-client-id EBAY_CLIENT_ID REPLACE_WITH_EBAY_APP_ID >/dev/null
); then
  assert_equals 'placeholder written for the sandbox target' \
    'ebay-client-id=REPLACE_WITH_EBAY_APP_ID' "$(cat "${AZ_WRITE_LOG}")"
else
  echo "  FAIL the non-production opt-in did not work" >&2
  failures=$((failures + 1))
fi
reset_vault

if ((failures > 0)); then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "All parameter resolution checks passed."
