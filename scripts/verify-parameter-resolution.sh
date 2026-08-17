#!/usr/bin/env bash
#
# Hermetic behavioural checks for scripts/bootstrap/common.sh.
#
# The static assertions in tests/unit/deployment-parameters.test.ts prove the scripts *reference*
# the canonical parameter file. This proves the shared behaviour itself: parameter resolution finds
# the committed file, layers an operator overlay, honours an explicit file, and aborts on a missing
# one; and `ensure_secret` writes only when a Key Vault secret is genuinely absent.
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

# --- ensure_secret ----------------------------------------------------------
#
# A Key Vault read can fail for reasons other than "the secret is not there": throttling, a
# transient 5xx, or missing data-plane RBAC. Treating any of those as absence would rotate a live
# connector API key or eBay verification token on the next provisioning run. These checks stub the
# `az` CLI to prove the function only writes when the secret is genuinely missing.

STUB_DIR="$(mktemp -d)"
trap 'rm -rf "${STUB_DIR}"' EXIT
cat >"${STUB_DIR}/az" <<'STUB'
#!/usr/bin/env bash
if [[ "$3" == "show" ]]; then
  case "${AZ_SHOW_BEHAVIOUR}" in
    found) exit 0 ;;
    missing) echo "(SecretNotFound) A secret with (name/id) missing-secret was not found in this key vault." >&2; exit 1 ;;
    throttled) echo "(429) Too many requests" >&2; exit 1 ;;
    forbidden) echo "(Forbidden) Caller is not authorized to perform action on resource." >&2; exit 1 ;;
  esac
fi
if [[ "$3" == "set" ]]; then
  echo "WROTE" >>"${AZ_WRITE_LOG}"
  exit 0
fi
exit 0
STUB
chmod +x "${STUB_DIR}/az"
export PATH="${STUB_DIR}:${PATH}"
export AZ_WRITE_LOG="${STUB_DIR}/writes"
: >"${AZ_WRITE_LOG}"

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
  assert_equals 'write performed' 'WROTE' "$(cat "${AZ_WRITE_LOG}")"
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

if ((failures > 0)); then
  echo "${failures} check(s) failed" >&2
  exit 1
fi
echo "All parameter resolution checks passed."
