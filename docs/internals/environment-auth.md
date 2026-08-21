# Environment Authentication Profile

> For maintainers. Using T3 Code? See [docs/user](../user/).

The environment server and the relay use separate credentials, issuers, and trust
boundaries. They intentionally use a similar OAuth-shaped model so that permission
checks and token exchange behavior can be audited against established concepts.

## Authorization Model

Environment authorization is capability-based. A session carries zero or more
OAuth-style scope strings:

| Scope                   | Permission                                                               |
| ----------------------- | ------------------------------------------------------------------------ |
| `orchestration:read`    | Read snapshots, status, events, configuration, and filesystem/VCS state. |
| `orchestration:operate` | Dispatch user operations and mutate environment-side workspace state.    |
| `terminal:operate`      | Create, attach, input, resize, clear, restart, and terminate terminals.  |
| `review:write`          | Read review diff previews used to compose review feedback.               |
| `access:read`           | Inspect pairing links and client sessions.                               |
| `access:write`          | Create or revoke pairing links and client sessions.                      |
| `relay:read`            | Inspect managed relay connectivity.                                      |
| `relay:write`           | Link, configure, or unlink managed relay connectivity.                   |

Ordinary pairing links grant the four client-operation scopes and read access to
managed relay connectivity:
`orchestration:read orchestration:operate terminal:operate review:write relay:read`.
The desktop bootstrap credential and command-line administrative bootstrap
credentials additionally grant `access:read access:write relay:write`.

## Authentication Flows

### Browser Session

`POST /api/auth/browser-session` consumes a one-time bootstrap credential and creates a
browser session cookie. The cookie is an HTTP transport adapter for the same
scoped session model; the response never exposes the session secret to browser
JavaScript.

### Bearer Access Token

Non-browser clients use `POST /oauth/token` with an
`application/x-www-form-urlencoded` body:

```text
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
subject_token=<bootstrap credential>
subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
requested_token_type=urn:ietf:params:oauth:token-type:access_token
scope=orchestration:read orchestration:operate terminal:operate review:write relay:read
```

Clients may additionally submit `client_label`, `client_device_type`, and
`client_os` extension parameters so the authorized-clients UI can identify the
device that established the session. These are presentation hints only; the
environment derives transport metadata such as IP address and user agent from
the request and does not use these fields for authorization.

The response has the token-exchange shape:

```json
{
  "access_token": "<opaque session token>",
  "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "orchestration:read orchestration:operate terminal:operate review:write relay:read"
}
```

Sessions issued from a plain bearer exchange use the store's
`DEFAULT_SESSION_TTL` of 30 days. The shorter one-hour `expires_in: 3600` applies
only to DPoP-bound exchanges, where the token is additionally constrained by a
proof key. See `SessionStore.ts` and `EnvironmentAuth.ts`.

Requested scopes must be a subset of the one-time bootstrap credential grant.
An ordinary paired client therefore cannot exchange its grant for
`access:read`, `access:write`, or `relay:write`.

### DPoP-Bound Access Token

The same `/oauth/token` exchange supports proof-of-possession tokens. A client
that sends a `DPoP` header has its proof verified by `verifyRequestDpopProof`;
the resulting JWK thumbprint is stored on the session, which is then issued with
method `dpop-access-token` and a one-hour TTL instead of the bearer default. An
invalid proof gets a DPoP challenge header and a credential error rather than a
bearer token.

`dpop-access-token` is advertised alongside `browser-session-cookie` and
`bearer-access-token` in the descriptor's `sessionMethods`
(`EnvironmentAuthPolicy.ts`), so clients can discover support rather than
assume it. Relay-brokered clients use this mode so that a leaked token cannot be
replayed without the corresponding key.

### Hosted Workspace Assertion

A Kubernetes-hosted T3 environment may opt into a control-plane bootstrap method by configuring all of:

```text
T3CODE_HOSTED_WORKSPACE_ISSUER
T3CODE_HOSTED_WORKSPACE_ID
T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_DIR
```

The public-key directory contains ES256 public PEM files named `<kid>.pem`. Private signing keys remain in the hosted control plane. Partial configuration fails server startup; absent configuration leaves this method disabled. Configured environments advertise `hosted-workspace-assertion` in `bootstrapMethods`.

The control plane loads its active signing key from external secret configuration:

```text
T3CODE_HOSTED_ASSERTION_ISSUER
T3CODE_HOSTED_ASSERTION_KEY_ID
T3CODE_HOSTED_ASSERTION_PRIVATE_KEY_FILE
T3CODE_HOSTED_ASSERTION_LIFETIME_SECONDS  # optional; defaults to 60
```

After browser-session authentication and organization authorization, clients request a single-use assertion through:

```text
POST /api/organizations/:organizationId/workspaces/:workspaceId/access-assertion
```

The control plane issues assertions only when PostgreSQL reports the matching workspace as `Ready` with an operator-projected environment ID. Members, admins, and owners receive ordinary client scopes. Viewers receive only `orchestration:read`. The signing-key ID must match a `<kid>.pem` entry in the public-key ConfigMap mounted into workspace Pods.

For browser access, `POST /api/organizations/:organizationId/workspaces/:workspaceId/proxy-session` creates an opaque, revocable workspace grant bound to the authenticated control-plane browser session and seals only that grant credential into an AES-256-GCM, `HttpOnly`, `Secure` proxy cookie. The proxy exchanges the grant for a short-lived T3 bearer token server-to-server and keeps that token only in its process-local cache. Raw bearer tokens are not returned to browser JavaScript, stored in PostgreSQL, or retained in the browser cookie. Revoking the control-plane browser session revokes every linked workspace grant.

The dedicated workspace proxy routes exact hosts shaped as `t3-<workspace-id>.<suffix>` and `code-<workspace-id>.<suffix>`. It decrypts the cookie, verifies the host/workspace binding, revalidates the grant against the control plane at least every 30 seconds, strips browser credentials and untrusted forwarding headers, and injects the cached T3 bearer token only toward port 3000. code-server traffic uses port 3001 and relies on the same proxy authorization. Browser origins must exactly match the requested workspace host for mutations and WebSocket upgrades. The proxy also revalidates open WebSockets and closes them when the grant is revoked.

The proxy and control plane share only the externally mounted proxy-session encryption key. The proxy has no database or Kubernetes credentials. Its NetworkPolicy permits ingress from Traefik and egress only to DNS and workspace ports 3000/3001.

The hosted management client is available at `/hosted`. It uses the shared `@t3tools/client-runtime/control-plane` boundary for identity, organization, workspace, storage, invitation, lifecycle, deletion, and proxy-session calls. The production static image is built by `apps/control-plane/Dockerfile.web` and runs without credentials or egress. External routing must send `/api`, `/healthz`, and `/readyz` to the control-plane Service and browser application routes/assets to `t3-hosted-web`, on one origin so the OIDC browser cookie remains host-only. Workspace wildcard hosts route to `t3-workspace-proxy`.

Gateway API manifests remain deferred until the cluster exposes Gateway API resources. Do not replace the same-origin split with baked frontend HTTP or WebSocket origins.

The authenticated workspace proxy submits the resulting assertion to:

```text
POST /api/auth/hosted-workspace-token
```

The assertion binds the hosted principal, organization, workspace, T3 environment ID, audience, scopes, expiry, and unique JTI. Its audience is `urn:t3:environment:<environment-id>` and its lifetime cannot exceed five minutes. Requested scopes must be a subset of ordinary client scopes; hosted assertions cannot grant environment access-management or relay-write capabilities.

The server atomically records a hash of `(issuer, JTI)` in `ServerSecretStore` before issuing an opaque T3 bearer session. Reuse returns `401 invalid_credential`. The resulting session expires no later than the assertion and follows the ordinary bearer-session and WebSocket-ticket flow. Raw assertions and control-plane private keys are not persisted.

### WebSocket Ticket

`POST /api/auth/websocket-ticket` accepts any authenticated session and returns
a short-lived, single-purpose WebSocket ticket, issued through
`EnvironmentAuth.issueWebSocketTicket` with a five-minute default TTL. The
client presents its bearer or DPoP credential in headers to get the ticket, then
appends only that ticket to the socket URL as `wsTicket`. This keeps long-lived
tokens and browser cookies out of WebSocket URLs while letting the handshake
authenticate.

The ticket carries its session's scopes; each RPC method then enforces
`orchestration:read`, `orchestration:operate`, `terminal:operate`,
`review:write`, `relay:write`, or `access:read` as appropriate, through
`RPC_REQUIRED_SCOPES` in `apps/server/src/auth/RpcAuthorization.ts`. Review feedback submission currently dispatches
an orchestration operation, so clients performing it also need
`orchestration:operate`. Creating a ticket is not authorization to call every
RPC method.

## Standards Alignment

- Bearer access tokens are used through the `Authorization: Bearer` scheme from
  RFC 6750.
- The token endpoint profiles the request and response vocabulary from OAuth 2.0
  Token Exchange (RFC 8693), including `subject_token`, `requested_token_type`,
  `access_token`, `issued_token_type`, and `token_type`.
- Scope values follow the OAuth 2.0 scope model from RFC 6749: space-delimited,
  unordered capabilities with subset checking during exchange.

This is intentionally not a general-purpose OAuth authorization server. The
environment bootstrap token type is private, the bootstrap cookie and WebSocket
connection-token routes are product-specific adapters, and the API returns its
typed `HttpApi` errors rather than implementing every OAuth error response
surface.

## Upgrade Behavior

Migration `031_AuthAuthorizationScopes` is a hard cutover from role-bearing auth
records to scoped records. It deletes existing pairing links and sessions while
leaving non-authentication environment state unchanged. Upgraded clients must
pair again; old `owner` or `client` credentials are never silently mapped to new
capabilities.

## Relay Boundary

Relay-managed tunnels use their own tokens and keys. The relay can reuse scope
parsing and token-exchange conventions, but an environment access token is not a
relay token and cannot be presented to the relay.
