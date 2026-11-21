#!/usr/bin/env bash
# Install charts/aula-mcp into a local kind cluster in both modes and run its
# helm tests. Builds the image from the checked-out code.
#
#   scripts/kind-test.sh           # create the cluster if needed, then test
#   KEEP=1 scripts/kind-test.sh    # leave the release installed afterwards
#   scripts/kind-test.sh delete    # remove the cluster
#
# Needs kind, helm, kubectl and podman or docker.
set -euo pipefail

CLUSTER=${CLUSTER:-aula-mcp}
NAMESPACE=aula-mcp
IMAGE=localhost/aula-mcp:dev
KAGENT_VERSION=${KAGENT_VERSION:-1.0.1}
CHART=charts/aula-mcp
cd "$(dirname "$0")/.."

if [[ ${1:-} == delete ]]; then
  kind delete cluster --name "$CLUSTER"
  exit
fi

engine=$(command -v podman || command -v docker)
ctx="kind-$CLUSTER"

if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --wait 120s
fi

echo "--- image"
"$engine" build -t "$IMAGE" .
archive=$(mktemp)
trap 'rm -f "$archive"' EXIT
"$engine" save -o "$archive" "$IMAGE"
kind load image-archive "$archive" --name "$CLUSTER"

echo "--- kagent CRDs $KAGENT_VERSION"
helm --kube-context "$ctx" upgrade --install kagent-crds \
  oci://ghcr.io/kagent-dev/kagent/helm/kagent-crds --version "$KAGENT_VERSION" \
  --namespace kagent --create-namespace --wait

install() {
  echo "--- $1"
  helm --kube-context "$ctx" upgrade --install aula-mcp "$CHART" \
    --namespace "$NAMESPACE" --create-namespace -f "$CHART/ci/$1-values.yaml" \
    --wait --timeout 3m
  helm --kube-context "$ctx" test aula-mcp --namespace "$NAMESPACE" --logs
}

install single-parent
install multi-parent-kagent

kubectl --context "$ctx" -n kagent get remotemcpserver aula-mcp \
  -o jsonpath='{.spec.tokenPassthrough} {.metadata.labels.kagent\.dev/discovery}{"\n"}' |
  grep -qx 'true disabled'
echo "RemoteMCPServer kagent/aula-mcp: tokenPassthrough on, discovery disabled"

# A pod outside kagent and without the client label must not get through.
if kubectl --context "$ctx" -n "$NAMESPACE" run np-check --rm -i --restart=Never \
  --image=curlimages/curl:8.17.0 -- \
  curl -s -m 5 -o /dev/null "http://aula-mcp:7878/healthz" >/dev/null 2>&1; then
  echo "NetworkPolicy let an unlisted pod through" >&2
  exit 1
fi
echo "NetworkPolicy blocks an unlisted pod"

if [[ -z ${KEEP:-} ]]; then
  helm --kube-context "$ctx" uninstall aula-mcp --namespace "$NAMESPACE"
fi
echo "--- all checks passed"
