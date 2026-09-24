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

export const OrganizationAction = Schema.Literals([
  "organization.read",
  "organization.manage",
  "membership.manage",
  "invitation.manage",
  "workspace.read",
  "workspace.create",
  "workspace.update",
  "workspace.delete",
  "storage.read",
  "storage.manage",
]);
export type OrganizationAction = typeof OrganizationAction.Type;

export class OrganizationAuthorizationError extends Schema.TaggedErrorClass<OrganizationAuthorizationError>()(
  "OrganizationAuthorizationError",
  {
    reason: Schema.Literals(["access_denied", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const allowedActions: Record<OrganizationRole, ReadonlySet<OrganizationAction>> = {
  viewer: new Set(["organization.read", "workspace.read", "storage.read"]),
  member: new Set([
    "organization.read",
    "workspace.read",
    "workspace.create",
    "workspace.update",
    "workspace.delete",
    "storage.read",
  ]),
  admin: new Set([
    "organization.read",
    "organization.manage",
    "membership.manage",
    "invitation.manage",
    "workspace.read",
    "workspace.create",
    "workspace.update",
    "workspace.delete",
    "storage.read",
    "storage.manage",
  ]),
  owner: new Set(OrganizationAction.literals),
};

export class OrganizationAuthorization extends Context.Service<
  OrganizationAuthorization,
  {
    readonly authorize: (
      principalId: PrincipalId,
      organizationId: OrganizationId,
      action: OrganizationAction,
    ) => Effect.Effect<OrganizationRole, OrganizationAuthorizationError>;
  }
>()("@t3tools/control-plane/OrganizationAuthorization") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const authorize: OrganizationAuthorization["Service"]["authorize"] = Effect.fn(
    "OrganizationAuthorization.authorize",
  )(function* (principalId, organizationId, action) {
    const rows = yield* sql<{ readonly role: OrganizationRole }>`
      SELECT memberships.role
      FROM organization_memberships AS memberships
      JOIN organizations ON organizations.id = memberships.organization_id
      JOIN principals ON principals.id = memberships.principal_id
      WHERE memberships.organization_id = ${organizationId}
        AND memberships.principal_id = ${principalId}
        AND memberships.status = 'active'
        AND organizations.status = 'active'
        AND principals.status = 'active'
    `.pipe(
      Effect.mapError(
        (cause) => new OrganizationAuthorizationError({ reason: "persistence_failed", cause }),
      ),
    );
    const role = rows[0]?.role;
    if (role === undefined || !allowedActions[role].has(action)) {
      return yield* new OrganizationAuthorizationError({ reason: "access_denied" });
    }
    return role;
  });
  return OrganizationAuthorization.of({ authorize });
});

export const layer = Layer.effect(OrganizationAuthorization, make);
