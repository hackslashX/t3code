# ADR 0002: Use a shared workspace namespace for trusted internal teams

- Status: proposed
- Date: 2026-06-17

## Context

The initial deployment targets one existing k3s cluster. Organizations represent trusted internal teams. Namespace-per-organization would improve administrative and policy isolation but adds lifecycle, quota, routing, and operator complexity before the workload model is proven.

A Kubernetes namespace, Pod Security Standards, and NetworkPolicy do not form a hard boundary against kernel or container-runtime escapes. T3, code-server, extensions, agents, and repository code can execute arbitrary user-directed processes.

## Decision

Use one shared workspace namespace for v1, protected by restricted Pod Security Standards, default-deny NetworkPolicy, narrow operator RBAC, admission policy, per-workspace ServiceAccounts without API permissions, and platform-owned route and volume references.

This decision is valid only for trusted internal teams. The architecture must avoid identifiers and APIs that prevent a later namespace-per-organization placement policy.

## Consequences

- Cluster setup and reconciliation are smaller for v1.
- Organization isolation must be enforced consistently in the database, proxy, volume registry, routes, labels, and tests.
- Shared namespace resource names and labels are not authorization evidence.
- Existing-PVC attachment is a high-risk operation and requires platform ownership plus immutable UID checks.
- Supporting mutually untrusted tenants requires revisiting this decision and likely adding namespace-per-organization, sandboxed runtimes, dedicated nodes, or separate clusters.
