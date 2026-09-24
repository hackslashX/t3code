# Hosted Workspaces Phase 0 Validation Matrix

> This matrix validates architecture spikes only. It must not be run against a production namespace or T3 home.

| Area          | Check                                 | Method                                          | Pass condition                                                            |
| ------------- | ------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| Cluster       | Supported Kubernetes and k3s versions | `discover.sh`                                   | Versions recorded; Gateway API version known                              |
| Gateway       | Traefik Gateway controller            | Discovery plus disposable route                 | GatewayClass accepted; HTTPRoutes reach both ports                        |
| Gateway       | WebSockets                            | T3 and code-server smoke tests                  | Upgrade, streaming, reconnect, and configured idle interval work          |
| Gateway       | TLS and host isolation                | Disposable wildcard/test host                   | HTTPS only; wrong host cannot reach another workspace                     |
| CNI           | Policy implementation                 | Identify CNI and run negative connectivity pods | Default-deny works for ingress and egress                                 |
| Storage       | StorageClass discovery                | Kubernetes API                                  | Classes, provisioners, default status, expansion, binding mode recorded   |
| Storage       | New PVC                               | Disposable manifest                             | Claim binds and data survives pod replacement                             |
| Storage       | Existing PVC                          | Reattach same disposable claim                  | Ownership/UID check passes; data remains; concurrent attach is rejected   |
| Pod security  | Restricted PSS                        | Server-side dry-run/admission                   | Spike pod admitted; privileged and hostPath variants rejected             |
| Runtime       | Non-root containers                   | Pod status and process IDs                      | Both containers run without root or privilege escalation                  |
| Runtime       | T3 identity                           | Delete/recreate pod                             | Environment ID and SQLite state persist; only one writer exists           |
| Lifecycle     | Manual stop/start                     | Remove/recreate compute only                    | PVC retained; stopped route closed; state returns after start             |
| Self-healing  | Unexpected pod deletion               | Delete pod while desired Running                | Controller/workload recreates it without duplicate writers                |
| OIDC          | Discovery and callback                | Test IdP                                        | Issuer, audience, signature, expiry, nonce, state, and PKCE validated     |
| Enrollment    | Invitation only                       | Integration test                                | Uninvited subject cannot activate membership; invited subject can         |
| Identity      | Stable subject mapping                | Change email at IdP                             | Same `(issuer, subject)` maps to same principal                           |
| Session       | Cookie and revocation                 | HTTP tests                                      | Secure attributes present; rotation/revocation closes access              |
| Auth handoff  | Valid assertion                       | Contract integration test                       | T3 issues only requested allowed scopes                                   |
| Auth handoff  | Confusion/replay cases                | Negative tests                                  | Wrong issuer/audience/workspace/environment, expiry, JTI replay rejected  |
| Authorization | Cross-org IDOR                        | API and proxy tests                             | Org A cannot observe or reach Org B resources                             |
| Secrets       | Persistence/log review                | DB query and log scan                           | No OIDC secret, signing key, provider/Git token, raw session or assertion |
| GPU           | Class discovery/scheduling            | Optional GPU node test                          | Approved class maps correctly; unavailable capacity is explicit           |
| Operations    | Correlation and redaction             | Logs/traces                                     | Request/org/workspace IDs present; secrets and source content absent      |

## Disposable manifest checks

```bash
cd spikes/hosted-workspace-k3s
./discover.sh
T3_IMAGE='<digest-pinned-image>' \
CODE_SERVER_IMAGE='<digest-pinned-image>' \
WORKSPACE_HOST='phase0.example.test' \
STORAGE_CLASS='longhorn' \
./render.sh > /tmp/t3-hosted-phase0.yaml

kubectl apply --dry-run=client -f /tmp/t3-hosted-phase0.yaml
kubectl apply --dry-run=server -f /tmp/t3-hosted-phase0.yaml
```

Applying the manifest changes the cluster and is deliberately not automated. Review the rendered namespace, hostname, images, Gateway parent, storage class, and cleanup command before applying it.

## Required negative tests

- Replace a container security context with `privileged: true`; admission rejects it.
- Add `hostPath`, `hostNetwork`, or service-account token automount; policy/admission rejects it.
- Connect from an unrelated pod to workspace ports; NetworkPolicy blocks it.
- Connect from the workspace to the Kubernetes API and another workspace; policy blocks it.
- Present a valid hosted assertion for another workspace or environment; T3 rejects it.
- Reuse a consumed assertion JTI; T3 rejects it.
- Attempt to attach a PVC by name without a matching platform volume record and UID; control plane rejects it.
- Stop a workspace and try its old route; no backend receives the request.

## Evidence to retain

Store sanitized Phase 0 evidence outside live application state:

- discovery output;
- rendered manifest hash;
- `kubectl` dry-run/admission output;
- Gateway and HTTPRoute conditions;
- WebSocket compatibility results;
- OIDC and assertion test report;
- identified gaps, owner, and disposition.

Never retain tokens, OIDC codes, kubeconfigs, source files, provider credentials, or raw environment state as evidence.
