# Hosted identity handoff spike

Contract-level Phase 0 proof for exchanging a hosted control-plane authorization decision for short-lived, workspace-bound T3 environment access.

It uses only Node's built-in cryptography and is deliberately not wired to an HTTP endpoint, database, OIDC provider, or production key store.

```bash
node --test hosted-assertion.test.mjs
```

The spike proves:

- ES256 asymmetric signing with `kid`-based overlapping key rotation;
- exact issuer and audience validation;
- principal, organization, workspace, and T3 environment binding;
- a maximum five-minute assertion lifetime;
- scope subset enforcement;
- single-use JTI replay protection;
- tamper and unknown-key rejection.

Production integration still needs:

- Effect schemas and typed HTTP contracts;
- key loading from mounted secret files or a JWKS endpoint;
- a shared replay store suitable for multiple T3 replicas/process restarts;
- an explicit hosted bootstrap method in the environment auth descriptor;
- issuance of the existing scoped T3 session and WebSocket ticket after validation;
- audit events that contain identifiers and outcomes but never raw assertions.
