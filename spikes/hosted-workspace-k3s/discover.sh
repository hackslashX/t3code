#!/usr/bin/env sh
set -eu

need() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'required command not found: %s\n' "$1" >&2
    exit 1
  }
}

need kubectl

printf '== context ==\n'
kubectl config current-context
printf '\n== versions ==\n'
kubectl version
printf '\n== nodes ==\n'
kubectl get nodes -o wide
printf '\n== gateway API ==\n'
kubectl get gatewayclasses.gateway.networking.k8s.io 2>&1 || true
kubectl api-resources --api-group=gateway.networking.k8s.io 2>&1 || true
printf '\n== Traefik ==\n'
kubectl get deploy,pod -A -l app.kubernetes.io/name=traefik -o wide 2>&1 || true
printf '\n== storage classes ==\n'
kubectl get storageclass -o custom-columns='NAME:.metadata.name,PROVISIONER:.provisioner,DEFAULT:.metadata.annotations.storageclass\.kubernetes\.io/is-default-class,EXPAND:.allowVolumeExpansion,BINDING:.volumeBindingMode,RECLAIM:.reclaimPolicy'
printf '\n== volume snapshot classes ==\n'
kubectl get volumesnapshotclass.snapshot.storage.k8s.io 2>&1 || true
printf '\n== CNI hints ==\n'
kubectl get daemonset -A -o custom-columns='NAMESPACE:.metadata.namespace,NAME:.metadata.name,IMAGES:.spec.template.spec.containers[*].image' | grep -E 'flannel|calico|cilium|canal|weave|antrea' 2>&1 || true
printf '\n== GPU capacity ==\n'
kubectl get nodes -o custom-columns='NAME:.metadata.name,NVIDIA:.status.allocatable.nvidia\.com/gpu,AMD:.status.allocatable.amd\.com/gpu' 2>&1 || true
printf '\n== workspace namespace, if present ==\n'
kubectl get namespace t3-workspace-spike --show-labels 2>&1 || true
printf '\nDiscovery is read-only. Review the CNI and Gateway implementation before applying spike manifests.\n'
