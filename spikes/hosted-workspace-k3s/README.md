# Hosted workspace k3s spike

Disposable Phase 0 assets for an existing k3s cluster. They do not install Kubernetes, Traefik, a CNI, Longhorn, an OIDC provider, or a production authentication proxy.

## Discover capabilities

```bash
./discover.sh > discovery.txt
```

This is read-only. Review the current context before running it.

## Render

Use test images whose entrypoints support the arguments in the template:

```bash
T3_IMAGE='<test T3 image>' \
CODE_SERVER_IMAGE='<test code-server image>' \
WORKSPACE_HOST='phase0.example.test' \
STORAGE_CLASS='longhorn-ssd-orion' \
./render.sh > /tmp/t3-hosted-phase0.yaml
```

Optional variables: `STORAGE_CLASS` (default `longhorn-ssd-orion` for the current test cluster), `GATEWAY_NAME` (default `traefik`), `GATEWAY_NAMESPACE` (default `kube-system`), and `PVC_SIZE` (default `10Gi`). Traefik's actual Gateway name and namespace are installation-specific; discovery does not assume them.

Validate without mutation:

```bash
kubectl apply --dry-run=client -f /tmp/t3-hosted-phase0.yaml
kubectl apply --dry-run=server -f /tmp/t3-hosted-phase0.yaml
```

Applying or deleting this manifest mutates the cluster. Review it and confirm the active context first. The template deliberately starts with default-deny networking and will not be reachable until you add selectors matching the installed Gateway and DNS components.

The direct HTTPRoutes and code-server `--auth none` setting exist only to test routing in a disposable namespace. Production traffic must pass through the authenticated workspace proxy. The spike uses ephemeral T3 home storage and therefore does not yet prove stable T3 environment identity; that is a separate Phase 0 acceptance item.

Cleanup after explicit review:

```bash
kubectl delete namespace t3-workspace-spike
```

Deleting the namespace may delete the spike PVC and its data according to the StorageClass reclaim policy.
