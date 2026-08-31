import * as PgClient from "@effect/sql-pg/PgClient";
import { type PrincipalId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class BrowserSessionError extends Schema.TaggedErrorClass<BrowserSessionError>()(
  "BrowserSessionError",
  {
    reason: Schema.Literals(["invalid_session", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface BrowserSessionPrincipal {
  readonly principalId: PrincipalId;
  readonly expiresAt: Date;
}

export class BrowserSessionStore extends Context.Service<
  BrowserSessionStore,
  {
    readonly issue: (
      principalId: PrincipalId,
      input?: { readonly ttlSeconds?: number; readonly oidcSessionId?: string },
    ) => Effect.Effect<{ readonly token: string; readonly expiresAt: Date }, BrowserSessionError>;
    readonly verify: (token: string) => Effect.Effect<BrowserSessionPrincipal, BrowserSessionError>;
    readonly revoke: (token: string) => Effect.Effect<void, BrowserSessionError>;
  }
>()("@t3tools/control-plane/BrowserSessionStore") {}

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest();
const persistenceError = (cause: unknown) =>
  new BrowserSessionError({ reason: "persistence_failed", cause });

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const issue: BrowserSessionStore["Service"]["issue"] = Effect.fn("BrowserSessionStore.issue")(
    function* (principalId, input) {
      const token = NodeCrypto.randomBytes(32).toString("base64url");
      const tokenHash = hashToken(token);
      const ttlSeconds = input?.ttlSeconds ?? 28_800;
      const rows = yield* sql<{ readonly expires_at: Date }>`
        INSERT INTO web_sessions (id_hash, principal_id, oidc_session_id, expires_at)
        VALUES (
          ${tokenHash}, ${principalId}, ${input?.oidcSessionId ?? null},
          now() + (${ttlSeconds} * interval '1 second')
        )
        RETURNING expires_at
      `.pipe(Effect.mapError(persistenceError));
      const expiresAt = rows[0]?.expires_at;
      if (expiresAt === undefined) return yield* persistenceError("session insert returned no row");
      return { token, expiresAt };
    },
  );

  const verify: BrowserSessionStore["Service"]["verify"] = Effect.fn("BrowserSessionStore.verify")(
    function* (token) {
      if (token.length === 0) return yield* new BrowserSessionError({ reason: "invalid_session" });
      const rows = yield* sql<{
        readonly principal_id: PrincipalId;
        readonly expires_at: Date;
      }>`
        UPDATE web_sessions AS sessions
        SET last_seen_at = now()
        FROM principals
        WHERE sessions.id_hash = ${hashToken(token)}
          AND sessions.principal_id = principals.id
          AND sessions.revoked_at IS NULL
          AND sessions.expires_at > now()
          AND principals.status = 'active'
        RETURNING sessions.principal_id, sessions.expires_at
      `.pipe(Effect.mapError(persistenceError));
      const row = rows[0];
      if (row === undefined) return yield* new BrowserSessionError({ reason: "invalid_session" });
      return { principalId: row.principal_id, expiresAt: row.expires_at };
    },
  );

  const revoke: BrowserSessionStore["Service"]["revoke"] = Effect.fn("BrowserSessionStore.revoke")(
    function* (token) {
      yield* sql`
        UPDATE web_sessions SET revoked_at = now()
        WHERE id_hash = ${hashToken(token)} AND revoked_at IS NULL
      `.pipe(Effect.mapError(persistenceError));
    },
  );

  return BrowserSessionStore.of({ issue, verify, revoke });
});

export const layer = Layer.effect(BrowserSessionStore, make);
