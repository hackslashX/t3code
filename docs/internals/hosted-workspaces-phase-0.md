# Hosted Workspaces: Phase 0 Architecture

> Status: proposed. This document defines the Phase 0 spikes and decisions for a Kubernetes-hosted extension of T3 Code. It does not describe functionality currently shipped.

## Goal

Prove the boundaries needed for a multi-organization hosted control plane where an invited OIDC user can start and stop persistent Kubernetes workspaces. Each running workspace contains one T3 server and one code-server instance and is reached through an authenticated proxy.

Phase 0 does not build the production control plane or create a Kubernetes cluster. The target is an existing k3s cluster with Traefik Gateway API support, its installed CNI, and discoverable StorageClasses. The first storage implementation is Longhorn, but workspace APIs deal in policy-approved StorageClasses rather than CSI vendors.

## Accepted constraints

- Organizations are trusted internal teams. Shared-namespace isolation protects against mistakes and ordinary workload compromise; it is not a hard hostile-tenant boundary.
- One existing k3s cluster and one shared workspace namespace.
- Generic OIDC Authorization Code flow with PKCE; invitation-only enrollment.
- User-owned Git and provider credentials.
- Traefik implements Gateway API.
- Manual `Running` and `Stopped` desired states in v1.
- New PVCs and approved existing PVC attachment.
- Optional admin-defined GPU classes.
- Restricted Pod Security Standards and default-deny NetworkPolicy.

## System boundary

```text
Browser
  | OIDC session and hosted APIs
  v
Hosted control plane ---- PostgreSQL
  | desired workspace state
  v
Workspace operator ---- Kubernetes API
  |                         |
  | status                  v
  +---------------- Workspace pod
                            |- T3 server
                            |- code-server
                            `- persistent volume

Browser -- Gateway -- authenticated workspace proxy -- workspace Service
```

Add a separate hosted control-plane application. Keep `apps/server` as the environment-local data plane. The T3 server continues to own provider processes, terminals, Git, filesystem access, orchestration, and environment SQLite state. It must not receive Kubernetes control-plane credentials.

Proposed implementation boundaries after Phase 0:

- `apps/control-plane`: OIDC, sessions, organizations, roles, quotas, workspace desired state, PostgreSQL, audit.
- `apps/workspace-operator`: Kubernetes reconciliation with narrow namespaced RBAC.
- `apps/workspace-proxy`: authorization and HTTP/WebSocket forwarding.
- `packages/hosted-contracts`: hosted control-plane schemas, separate from environment RPC.
- Existing `apps/server`: explicit hosted credential exchange and an externally routed code-server capability.
- Existing `packages/client-runtime`: hosted workspace catalog and short-lived target credential acquisition.

## Identity and authorization

### Login

1. Generate cryptographic `state`, `nonce`, and PKCE verifier.
2. Store only a short-lived login transaction. Redis is preferred; a database row may contain hashes and an encrypted verifier, but encryption keys remain external.
3. Redirect to the configured issuer discovered through OIDC metadata.
4. On callback, validate exact issuer, client audience, signature, expiry, nonce, state, and redirect URI before exchanging the code.
5. Resolve a principal by immutable `(issuer, subject)`. Email is profile data and never an identity key.
6. Require a pending invitation before creating or activating organization membership.
7. Create an opaque browser session. Persist only its hash. Set `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`.

### Secrets

OIDC client secrets, session signing/encryption keys, internal assertion keys, database credentials, Kubernetes credentials, provider tokens, Git credentials, and raw refresh tokens are not ordinary database fields. Supply platform secrets from mounted Kubernetes Secrets or an external secret manager. Prefer secret files over process arguments and redact all authentication material from logs and traces.

A workspace T3 server enables hosted assertion trust only when all three settings are present:

- `T3CODE_HOSTED_WORKSPACE_ISSUER`: exact hosted control-plane assertion issuer;
- `T3CODE_HOSTED_WORKSPACE_ID`: immutable hosted workspace identifier;
- `T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_DIR`: mounted directory of ES256 public PEM files named `<kid>.pem`.

Partial configuration fails startup. Absent configuration keeps hosted assertion auth disabled. Public keys may overlap during rotation; private signing keys never enter workspace pods.

User-owned provider and Git credentials remain inside that user's workspace security boundary. Phase 0 must determine whether they are entered interactively and retained on the workspace PVC or delivered through a dedicated per-user secret broker. They must never be copied into control-plane metadata or Kubernetes labels/annotations.

### Authorization

The hosted control plane owns organization membership and roles. Every workspace query and mutation is scoped by organization in the database. The proxy repeats authorization for every HTTP request and WebSocket upgrade. It strips inbound identity headers and uses mTLS or a signed, short-lived internal assertion to communicate an authenticated decision.

A hosted login must not become a long-lived T3 owner token. The handoff spike must prove this exchange:

```text
hosted session
  -> proxy authorizes principal + organization + workspace
  -> control plane signs short-lived assertion
  -> T3 validates issuer, audience, workspace/environment, expiry, nonce/JTI
  -> T3 issues its normal scoped session or WebSocket ticket
```

T3 retains method-level scope checks. Do not scrape startup pairing tokens from logs.

## Workspace desired state

A Workspace is durable desired configuration, not a Pod. Its initial lifecycle is:

```text
Stopped -> Starting -> Ready
Ready -> Stopping -> Stopped
Any state -> Deleting -> Deleted
```

Starting and stopping are idempotent desired-state updates. If desired state remains `Running`, Kubernetes and the operator recreate a failed pod. `Stopped` removes the pod, Service route, and ephemeral resources while retaining the workspace record and PVC. Deletion is separate and requires an explicit retain/delete volume policy.

Observed conditions include `StorageReady`, `Scheduled`, `PodReady`, `RouteReady`, and `Authenticated`, each with reason, message, observed generation, and transition time.

## Kubernetes realization

The operator reconciles a namespaced Workspace CR into:

1. a platform-owned PVC or a validated existing PVC attachment;
2. a ServiceAccount with no Kubernetes API permissions and token automount disabled;
3. a two-container Pod or single-replica workload;
4. a ClusterIP Service;
5. constrained Gateway API routing through the workspace proxy;
6. ingress and egress NetworkPolicies;
7. short-lived bootstrap secret references where required.

Use server-side apply and a dedicated field manager. Adopt resources only when controller identity and immutable workspace UID annotations match. Disposable resources use owner references. A finalizer revokes routes and credentials before applying explicit PVC retention policy.

### Pod policy

- T3 and code-server are separate non-root containers in one pod and one trust boundary.
- Persist the workspace and T3 home/environment ID. Never permit two active T3 writers on one volume.
- `allowPrivilegeEscalation: false`, all capabilities dropped, `RuntimeDefault` seccomp.
- No host namespaces, hostPath, privileged mode, Docker socket, arbitrary devices, or service-account token.
- Explicit CPU, memory, and ephemeral-storage requests and limits.
- Separate startup/readiness/liveness probes and graceful T3/SQLite shutdown.
- Digest-pinned, signed images from approved registries in production.

### Storage

The control plane discovers StorageClasses and filters them through administrator policy. A user selects a logical approved class, size, and supported access mode. Longhorn is the first tested backend but is not embedded in the API.

Existing PVCs are selectable only through platform volume records. Knowing a claim name is insufficient. The claim must be in the workspace namespace, match the organization ownership annotation and immutable UID, be unreserved, and support the requested access. One volume has at most one active workspace attachment.

### GPU

Users choose an admin-defined GPU class and count, never raw resource names, selectors, affinity, or tolerations. A class maps to an extended resource, node policy, maximum count, and quota. Unavailable GPU capacity produces an `Unschedulable` condition rather than a controller loop or silent fallback.

## Gateway and proxy

Prefer opaque workspace hosts to path-heavy multiplexing:

```text
https://<workspace-route>.workspaces.example.com/     -> code-server
https://<workspace-route>.workspaces.example.com/t3/  -> T3 HTTP
wss://<workspace-route>.workspaces.example.com/t3/ws  -> T3 RPC
```

The Phase 0 routing spike may route directly to a disposable Service only to test Traefik's Gateway API behavior. Production traffic must pass through the authenticated workspace proxy unless a later review proves an equivalent Traefik external-authorization policy for every HTTP request and WebSocket upgrade.

Test WebSocket upgrades, large uploads, path rewriting, forwarded headers, long idle timeouts, graceful drain, route status conditions, TLS, and behavior while a workspace is stopped. code-server's native password may be disabled only when it cannot be reached except through the authenticated proxy.

## Network isolation

Start with namespace default-deny ingress and egress. Permit workspace ingress only from the proxy/Gateway path to named ports. Permit egress only to DNS and approved destinations or an egress proxy. Deny workspace-to-workspace, workspace-to-control-plane, Kubernetes API, and cloud metadata access.

k3s defaults vary by installation. Phase 0 must record the actual CNI and verify that it enforces NetworkPolicy for pod, Gateway, DNS, and host-network traffic. Portable NetworkPolicy cannot express robust FQDN allowlists; use an egress proxy or a CNI extension if destination-level policy is required.

## Phase 0 spikes

### A. Cluster capability discovery

The script in `spikes/hosted-workspace-k3s/discover.sh` records Kubernetes, Gateway API, Traefik, StorageClass, VolumeSnapshotClass, GPU resource, Pod Security, and NetworkPolicy prerequisites without changing the cluster.

### B. Disposable workspace routing

The template in `spikes/hosted-workspace-k3s/workspace-spike.yaml.tpl` creates a restricted disposable namespace, PVC, two-container pod, Service, Gateway routes, and default-deny policy. `render.sh` validates required inputs and renders YAML; it does not apply it. The spike is intentionally not a production deployment and contains no hosted authentication.

### C. OIDC-to-T3 handoff

Implement a minimal contract-level spike after agreeing on assertion format. Acceptance requirements:

- asymmetric signature and key ID rotation;
- exact issuer and audience checks;
- workspace ID and T3 environment ID binding;
- principal, organization, allowed scopes, expiry no longer than five minutes, and unique JTI;
- replay rejection during assertion lifetime;
- no database or browser persistence of the assertion;
- resulting T3 session uses existing scope and WebSocket-ticket enforcement.

### D. code-server/T3 proxy compatibility

Run both services behind the selected route shape and verify normal HTTP, static assets, code-server WebSockets, T3 `/ws`, file uploads, terminal streaming, reconnect, prefix handling, and shutdown drain. This requires explicit permission before launching browser-based verification.

## Hosted workspace image

`apps/server/Dockerfile.hosted` builds the T3 server and web client as a non-root workspace image. Its runtime includes Git, OpenSSH, curl, ripgrep, and process inspection tools, but deliberately does not bake provider credentials or provider CLIs into the image. Users can persist their own executables below `/workspace/.local/bin` or `/workspace/.npm-global/bin`; both locations are present in the server process `PATH`.

Build and smoke-test it locally:

```bash
docker build -f apps/server/Dockerfile.hosted -t t3-hosted-workspace:test .
docker run --rm -p 3000:3000 \
  --tmpfs /workspace:uid=1000,gid=1000,mode=0700 \
  --tmpfs /tmp:uid=1000,gid=1000,mode=1777 \
  t3-hosted-workspace:test
```

Production workspace Pods mount `/workspace` from their PVC and hosted-auth public keys read-only. The application bundle remains root-owned and non-writable by UID 1000. Image profiles should reference immutable image digests after publishing; `latest` is only a deployment placeholder.

## Exit criteria

Phase 0 is complete when:

- the three architecture decisions in `docs/internals/adr/` are accepted;
- cluster discovery output confirms or identifies missing prerequisites;
- disposable manifests pass client and server-side dry-run plus restricted PSS admission;
- Traefik routes both services and preserves required WebSockets;
- the hosted assertion exchange passes success, expiry, audience, workspace, scope, key-rotation, and replay tests;
- a security review accepts shared-namespace risk for trusted internal teams;
- implementation estimates and blockers for Phase 1 are recorded.

See [the validation matrix](./hosted-workspaces-phase-0-validation.md) for exact checks.
