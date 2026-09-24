import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type OrganizationId,
  type OrganizationRole,
  type PrincipalId,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class IdentityQueryError extends Schema.TaggedErrorClass<IdentityQueryError>()(
  "IdentityQueryError",
  {
    reason: Schema.Literals(["principal_not_found", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface IdentitySummary {
  readonly principal: {
    readonly id: PrincipalId;
    readonly displayName: string;
    readonly email: string;
    readonly avatarUrl?: string;
  };
  readonly organizations: ReadonlyArray<{
    readonly id: OrganizationId;
    readonly slug: string;
    readonly name: string;
    readonly role: OrganizationRole;
  }>;
}

export class IdentityQuery extends Context.Service<
  IdentityQuery,
  {
    readonly get: (principalId: PrincipalId) => Effect.Effect<IdentitySummary, IdentityQueryError>;
  }
>()("@t3tools/control-plane/IdentityQuery") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const get: IdentityQuery["Service"]["get"] = Effect.fn("IdentityQuery.get")(
    function* (principalId) {
      const principals = yield* sql<{
        readonly id: PrincipalId;
        readonly display_name: string;
        readonly email: string;
        readonly avatar_url: string | null;
      }>`
      SELECT id, display_name, email, avatar_url
      FROM principals WHERE id = ${principalId} AND status = 'active'
    `.pipe(
        Effect.mapError((cause) => new IdentityQueryError({ reason: "persistence_failed", cause })),
      );
      const principal = principals[0];
      if (principal === undefined) {
        return yield* new IdentityQueryError({ reason: "principal_not_found" });
      }
      const organizations = yield* sql<{
        readonly id: OrganizationId;
        readonly slug: string;
        readonly name: string;
        readonly role: OrganizationRole;
      }>`
      SELECT organizations.id, organizations.slug, organizations.name, memberships.role
      FROM organization_memberships AS memberships
      JOIN organizations ON organizations.id = memberships.organization_id
      WHERE memberships.principal_id = ${principalId}
        AND memberships.status = 'active' AND organizations.status = 'active'
      ORDER BY lower(organizations.name), organizations.id
    `.pipe(
        Effect.mapError((cause) => new IdentityQueryError({ reason: "persistence_failed", cause })),
      );
      return {
        principal: {
          id: principal.id,
          displayName: principal.display_name,
          email: principal.email,
          ...(principal.avatar_url === null ? {} : { avatarUrl: principal.avatar_url }),
        },
        organizations,
      };
    },
  );
  return IdentityQuery.of({ get });
});

export const layer = Layer.effect(IdentityQuery, make);
