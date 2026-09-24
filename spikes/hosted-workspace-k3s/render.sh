#!/usr/bin/env sh
set -eu

: "${T3_IMAGE:?set T3_IMAGE to a test image reference}"
: "${CODE_SERVER_IMAGE:?set CODE_SERVER_IMAGE to a test image reference}"
: "${WORKSPACE_HOST:?set WORKSPACE_HOST to a disposable DNS host}"

STORAGE_CLASS=${STORAGE_CLASS:-longhorn-ssd-orion}
GATEWAY_NAME=${GATEWAY_NAME:-traefik}
GATEWAY_NAMESPACE=${GATEWAY_NAMESPACE:-kube-system}
PVC_SIZE=${PVC_SIZE:-10Gi}

case "$WORKSPACE_HOST" in
  *[!A-Za-z0-9.-]*|.*|*.) printf 'invalid WORKSPACE_HOST: %s\n' "$WORKSPACE_HOST" >&2; exit 1 ;;
esac
case "$PVC_SIZE" in
  *[!A-Za-z0-9.]*|'') printf 'invalid PVC_SIZE: %s\n' "$PVC_SIZE" >&2; exit 1 ;;
esac

export T3_IMAGE CODE_SERVER_IMAGE WORKSPACE_HOST STORAGE_CLASS GATEWAY_NAME GATEWAY_NAMESPACE PVC_SIZE

if command -v envsubst >/dev/null 2>&1; then
  envsubst < workspace-spike.yaml.tpl
else
  printf 'envsubst is required (usually provided by gettext)\n' >&2
  exit 1
fi
