# ADR 0001: Separate the hosted control plane from the T3 environment server

- Status: proposed
- Date: 2026-06-17

## Context

The existing T3 server represents one execution environment. It owns a filesystem, provider processes, terminals, Git operations, SQLite state, and environment authentication. A hosted Kubernetes product additionally needs tenant identity, organizations, roles, quotas, workspace lifecycle, routing, and Kubernetes credentials.

Adding those concerns to `apps/server` would give every workspace runtime cluster privileges and force multi-tenancy into an environment-local persistence and RPC model.

## Decision

Create a separate hosted control-plane application and a narrowly privileged workspace operator. Keep `apps/server` as the per-workspace data plane inside each workspace pod.

Hosted contracts remain separate from the environment Effect RPC group. The web client first talks to the hosted control plane, then resolves a selected workspace to the existing T3 environment protocol through an authenticated proxy.

## Consequences

- Existing local, desktop, mobile, and remote environment behavior remains viable.
- Kubernetes credentials stay out of workspace pods.
- Hosted identity and environment capability authorization remain separate trust boundaries.
- A deliberate short-lived credential exchange is required between hosted sessions and T3 sessions.
- Deployment has more components, but each component has a smaller privilege and domain boundary.
