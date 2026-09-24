import * as PgClient from "@effect/sql-pg/PgClient";
import type {
  OrganizationId,
  OrganizationMemberSummary,
  OrganizationRole,
  PrincipalId,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class OrganizationRepositoryError extends Schema.TaggedErrorClass<OrganizationRepositoryError>()(
  "OrganizationRepositoryError",
  {
    reason: Schema.Literals(["organization_not_found", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class OrganizationRepository extends Context.Service<
  OrganizationRepository,
  {
    readonly listMembers: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<OrganizationMemberSummary>, OrganizationRepositoryError>;
    readonly updateMemberRole: (
      organizationId: OrganizationId,
      principalId: PrincipalId,
      role: Exclude<OrganizationRole, "owner">,
      actorPrincipalId: PrincipalId,
      requestId: string,
    ) => Effect.Effect<void, OrganizationRepositoryError>;
    readonly rename: (
      organizationId: OrganizationId,
      name: string,
      actorPrincipalId: PrincipalId,
      requestId: string,
    ) => Effect.Effect<void, OrganizationRepositoryError>;
  }
>()("@t3tools/control-plane/OrganizationRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const listMembers: OrganizationRepository["Service"]["listMembers"] = Effect.fn(
    "OrganizationRepository.listMembers",
  )(function* (organizationId) {
    return yield* sql<{
      readonly principal_id: PrincipalId;
      readonly display_name: string;
      readonly email: string;
      readonly avatar_url: string | null;
      readonly role: OrganizationRole;
      readonly status: "invited" | "active" | "suspended";
    }>`
      SELECT memberships.principal_id, principals.display_name, principals.email, principals.avatar_url,
             memberships.role, memberships.status
      FROM organization_memberships AS memberships
      JOIN principals ON principals.id = memberships.principal_id
      WHERE memberships.organization_id = ${organizationId}
      ORDER BY lower(principals.display_name), principals.id
    `.pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          principalId: row.principal_id,
          displayName: row.display_name,
          email: row.email,
          ...(row.avatar_url === null ? {} : { avatarUrl: row.avatar_url }),
          role: row.role,
          status: row.status,
        })),
      ),
      Effect.mapError(
        (cause) => new OrganizationRepositoryError({ reason: "persistence_failed", cause }),
      ),
    );
  });
  const updateMemberRole: OrganizationRepository["Service"]["updateMemberRole"] = Effect.fn(
    "OrganizationRepository.updateMemberRole",
  )(function* (organizationId, principalId, role, actorPrincipalId, requestId) {
    const rows = yield* sql<{ readonly principal_id: PrincipalId }>`
      UPDATE organization_memberships SET role = ${role}, updated_at = now()
      WHERE organization_id = ${organizationId} AND principal_id = ${principalId} AND role <> 'owner'
      RETURNING principal_id
    `.pipe(
      Effect.mapError(
        (cause) => new OrganizationRepositoryError({ reason: "persistence_failed", cause }),
      ),
    );
    if (rows[0] === undefined)
      return yield* new OrganizationRepositoryError({ reason: "organization_not_found" });
    yield* sql`
      INSERT INTO audit_events (request_id, actor_principal_id, organization_id, action, resource_type, resource_id, result, metadata)
      VALUES (${requestId}, ${actorPrincipalId}, ${organizationId}, 'membership.role.update', 'organization_membership', ${principalId}, 'allowed', ${sql.json({ role })})
    `.pipe(
      Effect.mapError(
        (cause) => new OrganizationRepositoryError({ reason: "persistence_failed", cause }),
      ),
    );
  });
  const rename: OrganizationRepository["Service"]["rename"] = Effect.fn(
    "OrganizationRepository.rename",
  )(function* (organizationId, name, actorPrincipalId, requestId) {
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: OrganizationId }>`
          UPDATE organizations SET name = ${name}, updated_at = now()
          WHERE id = ${organizationId} AND status = 'active'
          RETURNING id
        `;
          if (rows[0] === undefined) {
            return yield* new OrganizationRepositoryError({ reason: "organization_not_found" });
          }
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, metadata
          ) VALUES (
            ${requestId}, ${actorPrincipalId}, ${organizationId}, 'organization.rename',
            'organization', ${organizationId}, 'allowed', ${sql.json({ name })}
          )
        `;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(OrganizationRepositoryError)(cause)
            ? cause
            : new OrganizationRepositoryError({ reason: "persistence_failed", cause }),
        ),
      );
  });
  return OrganizationRepository.of({ listMembers, updateMemberRole, rename });
});

export const layer = Layer.effect(OrganizationRepository, make);
