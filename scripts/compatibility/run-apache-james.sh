#!/usr/bin/env bash
set -euo pipefail

readonly SERVER_PROFILE="apache-james"
readonly SERVER_VERSION="${JAMES_VERSION:-3.9.0}"
readonly SERVER_IMAGE="${JAMES_IMAGE:-apache/james:memory-${SERVER_VERSION}@sha256:c7d6172292a902ca7be5f16dace658f42d31bfca62a0a38598bee7a6dab09434}"
readonly HOST_PORT="${JMAP_LAB_PORT:-18080}"
readonly WEBADMIN_PORT="${JMAP_LAB_WEBADMIN_PORT:-18000}"
readonly SMTP_PORT="${JMAP_LAB_SMTP_PORT:-18025}"
readonly LAB_DOMAIN="example.test"
readonly LAB_USERNAME="compat@${LAB_DOMAIN}"
readonly LAB_PASSWORD="compat-password"
readonly CONTAINER_NAME="openclaw-jmap-james-${$}"
readonly REPORT_PATH="${COMPATIBILITY_REPORT:-compatibility-report.json}"
readonly STATEFUL_REPORT_PATH="${STATEFUL_CONTRACT_REPORT:-}"
readonly OUTBOUND_REPORT_PATH="${OUTBOUND_CONTRACT_REPORT:-}"
readonly LAB_SCOPE="${JMAP_COMPATIBILITY_SCOPE:-full}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly JMAP_CONFIG="${REPO_ROOT}/compatibility-lab/apache-james/jmap.properties"

temp_dir=""

# shellcheck disable=SC2329 # invoked through the EXIT trap
cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  if [[ -n "${temp_dir}" && -d "${temp_dir}" ]]; then
    rm -rf "${temp_dir}"
  fi
}
trap cleanup EXIT

for command in docker keytool curl jq node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command}" >&2
    exit 69
  fi
done

if [[ ! -f "${REPO_ROOT}/dist/src/compatibility-bin.js" ]]; then
  printf 'Build the project before running the compatibility lab.\n' >&2
  exit 66
fi

temp_dir="$(mktemp -d)"
readonly KEYSTORE_PATH="${temp_dir}/keystore"

keytool -genkeypair \
  -alias james \
  -keyalg RSA \
  -keysize 2048 \
  -storetype PKCS12 \
  -keystore "${KEYSTORE_PATH}" \
  -storepass james72laBalle \
  -keypass james72laBalle \
  -dname "CN=localhost, OU=JMAP Lab, O=OpenClaw, L=Test, ST=Test, C=US" \
  -validity 2 \
  >/dev/null 2>&1

docker run --detach \
  --name "${CONTAINER_NAME}" \
  --env "DOMAIN=${LAB_DOMAIN}" \
  --env "JMAP_URL_PREFIX=http://127.0.0.1:${HOST_PORT}" \
  --volume "${KEYSTORE_PATH}:/root/conf/keystore:ro" \
  --volume "${JMAP_CONFIG}:/root/conf/jmap.properties:ro" \
  --publish "127.0.0.1:${HOST_PORT}:80" \
  --publish "127.0.0.1:${WEBADMIN_PORT}:8000" \
  --publish "127.0.0.1:${SMTP_PORT}:25" \
  "${SERVER_IMAGE}" \
  >/dev/null

ready=false
for _attempt in $(seq 1 60); do
  if curl --silent --fail --max-time 2 \
    "http://127.0.0.1:${WEBADMIN_PORT}/healthcheck" \
    | jq -e '.status == "healthy"' \
    >/dev/null 2>&1; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}")" != "true" ]]; then
    printf 'Apache James stopped before becoming healthy.\n' >&2
    docker logs --tail 120 "${CONTAINER_NAME}" >&2
    exit 70
  fi
  sleep 2
done

if [[ "${ready}" != "true" ]]; then
  printf 'Apache James did not become healthy in time.\n' >&2
  docker logs --tail 120 "${CONTAINER_NAME}" >&2
  exit 70
fi

docker exec "${CONTAINER_NAME}" \
  james-cli AddUser "${LAB_USERNAME}" "${LAB_PASSWORD}" \
  >/dev/null 2>&1

printf '%s\r\n' \
  'From: Compatibility Sender <sender@outside.test>' \
  "To: ${LAB_USERNAME}" \
  'Subject: JMAP compatibility lab seed' \
  'Date: Thu, 01 Jan 2026 00:00:00 +0000' \
  'Message-ID: <compatibility-seed@outside.test>' \
  '' \
  'Metadata-only compatibility seed.' \
  | curl --silent --show-error --fail \
      --url "smtp://127.0.0.1:${SMTP_PORT}" \
      --mail-from "sender@outside.test" \
      --mail-rcpt "${LAB_USERNAME}" \
      --upload-file - \
      >/dev/null

export JMAP_SESSION_URL="http://127.0.0.1:${HOST_PORT}/jmap/session"
export JMAP_AUTH_MODE="basic"
export JMAP_USERNAME="${LAB_USERNAME}"
export JMAP_PASSWORD="${LAB_PASSWORD}"

metadata_verified=false
probe_exit_code=4
for _attempt in $(seq 1 20); do
  set +e
  node "${REPO_ROOT}/dist/src/compatibility-bin.js" \
    --server "${SERVER_PROFILE}" \
    --scope "${LAB_SCOPE}" \
    --json \
    >"${REPORT_PATH}"
  probe_exit_code=$?
  set -e
  if jq -e \
    '.checks[] | select(.id == "email-metadata") | .status == "pass"' \
    "${REPORT_PATH}" \
    >/dev/null; then
    metadata_verified=true
    break
  fi
  sleep 1
done

jq -e . "${REPORT_PATH}" >/dev/null
if [[ "${metadata_verified}" != "true" ]]; then
  printf 'Apache James did not expose the local seed through Email/get in time.\n' >&2
  exit 70
fi
jq -c \
  --arg serverVersion "${SERVER_VERSION}" \
  --arg image "${SERVER_IMAGE}" \
  --argjson exitCode "${probe_exit_code}" \
  '{
    serverProfile,
    serverVersion: $serverVersion,
    image: $image,
    scope,
    verdict,
    exitCode: $exitCode,
    failedChecks: [.checks[] | select(.status != "pass") | {
      id,
      status,
      required,
      code
    }],
    probePolicy
  }' \
  "${REPORT_PATH}"

stateful_exit_code=0
if [[ -n "${STATEFUL_REPORT_PATH}" ]]; then
  set +e
  JMAP_STATEFUL_TEST_ALLOW_MUTATION=draft-only \
    JMAP_TEST_ACCOUNT_CLASS=disposable \
    node "${REPO_ROOT}/dist/src/stateful-contract-bin.js" \
      --server "${SERVER_PROFILE}" \
      --json \
      >"${STATEFUL_REPORT_PATH}"
  stateful_exit_code=$?
  set -e
  jq -e . "${STATEFUL_REPORT_PATH}" >/dev/null
  jq -c \
    --arg serverVersion "${SERVER_VERSION}" \
    --arg image "${SERVER_IMAGE}" \
    --argjson exitCode "${stateful_exit_code}" \
    '{
      serverProfile,
      serverVersion: $serverVersion,
      image: $image,
      contract,
      verdict,
      exitCode: $exitCode,
      failedChecks: [.checks[] | select(.status != "pass")],
      probePolicy
    }' \
    "${STATEFUL_REPORT_PATH}"
fi

outbound_exit_code=0
if [[ -n "${OUTBOUND_REPORT_PATH}" ]]; then
  set +e
  JMAP_OUTBOUND_TEST_ALLOW_DELIVERY=self-only \
    JMAP_TEST_ACCOUNT_CLASS=disposable \
    node "${REPO_ROOT}/dist/src/outbound-contract-bin.js" \
      --server "${SERVER_PROFILE}" \
      --json \
      >"${OUTBOUND_REPORT_PATH}"
  outbound_exit_code=$?
  set -e
  jq -e . "${OUTBOUND_REPORT_PATH}" >/dev/null
  jq -c \
    --arg serverVersion "${SERVER_VERSION}" \
    --arg image "${SERVER_IMAGE}" \
    --argjson exitCode "${outbound_exit_code}" \
    '{
      serverProfile,
      serverVersion: $serverVersion,
      image: $image,
      contract,
      verdict,
      exitCode: $exitCode,
      failedChecks: [.checks[] | select(.status != "pass")],
      observations,
      probePolicy
    }' \
    "${OUTBOUND_REPORT_PATH}"
fi

if [[ "${probe_exit_code}" -ne 0 ]]; then
  exit "${probe_exit_code}"
fi
if [[ "${stateful_exit_code}" -ne 0 ]]; then
  exit "${stateful_exit_code}"
fi
exit "${outbound_exit_code}"
