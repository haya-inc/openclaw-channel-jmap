#!/usr/bin/env bash
set -euo pipefail

readonly SERVER_PROFILE="cyrus"
readonly SERVER_VERSION="${CYRUS_VERSION:-3.13.6}"
readonly CYRUS_REF="${CYRUS_REF:-cyrus-imapd-${SERVER_VERSION}}"
readonly SERVER_IMAGE="${CYRUS_LAB_IMAGE:-openclaw-channel-jmap/cyrus-lab:${SERVER_VERSION}}"
readonly HOST_PORT="${JMAP_LAB_PORT:-18081}"
readonly IMAP_PORT="${JMAP_LAB_IMAP_PORT:-18143}"
readonly LAB_USERNAME="compat@example.test"
readonly LAB_PASSWORD="compat-password"
readonly CONTAINER_NAME="openclaw-jmap-cyrus-${$}"
readonly REPORT_PATH="${COMPATIBILITY_REPORT:-compatibility-report.json}"
readonly LAB_SCOPE="${JMAP_COMPATIBILITY_SCOPE:-full}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
readonly REPO_ROOT
readonly LAB_DIR="${REPO_ROOT}/compatibility-lab/cyrus"
SEED_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-jmap-cyrus-seed.XXXXXX")"
readonly SEED_FILE

# shellcheck disable=SC2329 # invoked through the EXIT trap
cleanup() {
  docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  rm -f "${SEED_FILE}"
}
trap cleanup EXIT

for command in docker curl jq node; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    printf 'Required command is unavailable: %s\n' "${command}" >&2
    exit 69
  fi
done

if [[ ! -f "${REPO_ROOT}/dist/src/compatibility-bin.js" ]]; then
  printf 'Build the project before running the compatibility lab.\n' >&2
  exit 66
fi

if [[ "${CYRUS_LAB_SKIP_BUILD:-false}" != "true" ]]; then
  docker build \
    --build-arg "CYRUS_REF=${CYRUS_REF}" \
    --tag "${SERVER_IMAGE}" \
    "${LAB_DIR}"
fi

docker run --detach \
  --name "${CONTAINER_NAME}" \
  --publish "127.0.0.1:${HOST_PORT}:8080" \
  --publish "127.0.0.1:${IMAP_PORT}:1143" \
  "${SERVER_IMAGE}" \
  >/dev/null

ready=false
for _attempt in $(seq 1 60); do
  http_code="$(
    curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 \
      "http://127.0.0.1:${HOST_PORT}/.well-known/jmap" \
      || true
  )"
  if [[ "${http_code}" != "000" ]]; then
    ready=true
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "${CONTAINER_NAME}")" != "true" ]]; then
    printf 'Cyrus stopped before becoming ready.\n' >&2
    docker logs --tail 160 "${CONTAINER_NAME}" >&2
    exit 70
  fi
  sleep 2
done

if [[ "${ready}" != "true" ]]; then
  printf 'Cyrus did not become ready in time.\n' >&2
  docker logs --tail 160 "${CONTAINER_NAME}" >&2
  exit 70
fi

# The first successful IMAP login creates the test user's INBOX.
curl --silent --show-error --fail \
  --user "${LAB_USERNAME}:${LAB_PASSWORD}" \
  "imap://127.0.0.1:${IMAP_PORT}/INBOX" \
  >/dev/null

# Add one local-only message so Email/get and Thread/get can be invoked.
printf '%s\r\n' \
  'From: Compatibility Sender <sender@outside.test>' \
  "To: ${LAB_USERNAME}" \
  'Subject: JMAP compatibility lab seed' \
  'Date: Thu, 01 Jan 2026 00:00:00 +0000' \
  'Message-ID: <compatibility-seed@outside.test>' \
  '' \
  'Metadata-only compatibility seed.' \
  >"${SEED_FILE}"
curl --silent --show-error --fail \
  --user "${LAB_USERNAME}:${LAB_PASSWORD}" \
  --url "imap://127.0.0.1:${IMAP_PORT}/INBOX" \
  --upload-file "${SEED_FILE}" \
  >/dev/null

export JMAP_SESSION_URL="http://127.0.0.1:${HOST_PORT}/.well-known/jmap"
export JMAP_AUTH_MODE="basic"
export JMAP_USERNAME="${LAB_USERNAME}"
export JMAP_PASSWORD="${LAB_PASSWORD}"

set +e
node "${REPO_ROOT}/dist/src/compatibility-bin.js" \
  --server "${SERVER_PROFILE}" \
  --scope "${LAB_SCOPE}" \
  --json \
  >"${REPORT_PATH}"
probe_exit_code=$?
set -e

jq -e . "${REPORT_PATH}" >/dev/null
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

exit "${probe_exit_code}"
