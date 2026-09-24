import * as PgClient from "@effect/sql-pg/PgClient";
import { type OrganizationId, type PrincipalId, WorkspaceId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WorkspaceProxyGrantError extends Schema.TaggedErrorClass<WorkspaceProxyGrantError>()(
  "WorkspaceProxyGrantError",
  { reason: Schema.Literals(["invalid_grant", "persistence_failed"]), cause: Schema.optionalKey(Schema.Defect()) },
) {}

export interface WorkspaceProxyGrant {
  readonly principalId: PrincipalId;
  readonly organizationId: OrganizationId;
  readonly workspaceId: WorkspaceId;
}

export class WorkspaceProxyGrantStore extends Context.Service<WorkspaceProxyGrantStore, {
  readonly issue: (input: { readonly browserSessionToken: string; readonly principalId: PrincipalId; readonly organizationId: OrganizationId; readonly workspaceId: WorkspaceId }) => Effect.Effect<{ readonly credential: string }, WorkspaceProxyGrantError>;
  readonly verify: (credential: string, workspaceId: WorkspaceId) => Effect.Effect<WorkspaceProxyGrant, WorkspaceProxyGrantError>;
  readonly revokeByBrowserSession: (browserSessionToken: string) => Effect.Effect<void, WorkspaceProxyGrantError>;
}>()("@t3tools/control-plane/WorkspaceProxyGrantStore") {}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();
const persistenceError = (cause: unknown) => new WorkspaceProxyGrantError({ reason: "persistence_failed", cause });

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  return WorkspaceProxyGrantStore.of({
    issue: Effect.fn("WorkspaceProxyGrantStore.issue")(function* (input) {
      const credential = NodeCrypto.randomBytes(32).toString("base64url");
      yield* sql`
        INSERT INTO workspace_proxy_grants (id, credential_hash, browser_session_hash, principal_id, organization_id, workspace_id, expires_at)
        VALUES (${NodeCrypto.randomUUID()}, ${hash(credential)}, ${hash(input.browserSessionToken)}, ${input.principalId}, ${input.organizationId}, ${input.workspaceId}, now() + interval '8 hours')
      `.pipe(Effect.mapError(persistenceError));
      return { credential };
    }),
    verify: Effect.fn("WorkspaceProxyGrantStore.verify")(function* (credential, workspaceId) {
      const rows = yield* sql<WorkspaceProxyGrant>`
        SELECT grants.principal_id AS "principalId", grants.organization_id AS "organizationId", grants.workspace_id AS "workspaceId"
        FROM workspace_proxy_grants AS grants
        JOIN web_sessions AS sessions ON sessions.id_hash = grants.browser_session_hash
        JOIN principals ON principals.id = grants.principal_id
        WHERE grants.credential_hash = ${hash(credential)}
          AND grants.workspace_id = ${workspaceId}
          AND grants.revoked_at IS NULL AND grants.expires_at > now()
          AND sessions.revoked_at IS NULL AND sessions.expires_at > now()
          AND principals.status = 'active'
      `.pipe(Effect.mapError(persistenceError));
      const grant = rows[0];
      if (grant === undefined) return yield* new WorkspaceProxyGrantError({ reason: "invalid_grant" });
      return { ...grant, workspaceId: WorkspaceId.make(grant.workspaceId) };
    }),
    revokeByBrowserSession: Effect.fn("WorkspaceProxyGrantStore.revokeByBrowserSession")(function* (browserSessionToken) {
      yield* sql`UPDATE workspace_proxy_grants SET revoked_at = now() WHERE browser_session_hash = ${hash(browserSessionToken)} AND revoked_at IS NULL`.pipe(Effect.mapError(persistenceError));
    }),
  });
});
export const layer = Layer.effect(WorkspaceProxyGrantStore, make);
