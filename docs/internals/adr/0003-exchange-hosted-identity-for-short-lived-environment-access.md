# ADR 0003: Exchange hosted identity for short-lived environment access

- Status: proposed
- Date: 2026-06-17

## Context

The hosted control plane authenticates users through generic OIDC. The T3 environment server already uses scoped environment sessions and short-lived WebSocket tickets. OIDC identity is not itself an environment capability grant, and storing a long-lived owner pairing token in the control plane or browser would weaken revocation and workspace isolation.

Trusting unsigned proxy headers or scraping startup pairing tokens from pod logs would create confused-deputy and secret-disclosure risks.

## Decision

The workspace proxy authorizes the hosted session and requests a short-lived, asymmetrically signed platform assertion. The assertion is bound to issuer, audience, principal, organization, workspace, T3 environment ID, allowed scopes, expiry of at most five minutes, and a unique JTI. T3 validates it and issues its normal scoped session or WebSocket ticket. Assertion JTIs are single use during their lifetime.

Signing keys and workspace bootstrap trust are supplied from external secret storage, never ordinary application database rows. Assertions are not persisted in the browser or database.

## Consequences

- Hosted membership revocation and workspace reassignment do not depend on deleting a long-lived browser bearer token.
- T3 retains method-level scope enforcement.
- Key rotation, audience separation, replay protection, and proxy-to-T3 trust need explicit implementation and tests.
- The environment auth contract gains a hosted bootstrap method, but remains independent from any specific OIDC provider.
