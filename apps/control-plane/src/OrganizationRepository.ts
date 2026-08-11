import * as PgClient from "@effect/sql-pg/PgClient";
import type { OrganizationId, PrincipalId } from "@t3tools/hosted-contracts";
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
  return OrganizationRepository.of({ rename });
});

export const layer = Layer.effect(OrganizationRepository, make);
