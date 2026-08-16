import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type OrganizationId,
  type OrganizationRole,
  type PrincipalId,
} from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export type InvitationRole = Exclude<OrganizationRole, "owner">;

export class InvitationRepositoryError extends Schema.TaggedErrorClass<InvitationRepositoryError>()(
  "InvitationRepositoryError",
  {
    reason: Schema.Literals([
      "invalid_email",
      "invalid_expiry",
      "invitation_not_found",
      "persistence_failed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface CreateInvitationInput {
  readonly invitationId: string;
  readonly organizationId: OrganizationId;
  readonly email: string;
  readonly role: InvitationRole;
  readonly invitedByPrincipalId: PrincipalId;
  readonly expiresInSeconds?: number;
  readonly requestId: string;
  readonly sourceIp?: string;
}

export class InvitationRepository extends Context.Service<
  InvitationRepository,
  {
    readonly create: (
      input: CreateInvitationInput,
    ) => Effect.Effect<
      { readonly token: string; readonly expiresAt: Date },
      InvitationRepositoryError
    >;
    readonly revoke: (
      invitationId: string,
      organizationId: OrganizationId,
      actorPrincipalId: PrincipalId,
      requestId: string,
    ) => Effect.Effect<void, InvitationRepositoryError>;
  }
>()("@t3tools/control-plane/InvitationRepository") {}

const persistenceError = (cause: unknown) =>
  Schema.is(InvitationRepositoryError)(cause)
    ? cause
    : new InvitationRepositoryError({ reason: "persistence_failed", cause });

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const create: InvitationRepository["Service"]["create"] = Effect.fn(
    "InvitationRepository.create",
  )(function* (input) {
    const email = input.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return yield* new InvitationRepositoryError({ reason: "invalid_email" });
    }
    const expiresInSeconds = input.expiresInSeconds ?? 604_800;
    if (expiresInSeconds < 60 || expiresInSeconds > 2_592_000) {
      return yield* new InvitationRepositoryError({ reason: "invalid_expiry" });
    }
    const token = NodeCrypto.randomBytes(32).toString("base64url");
    const tokenHash = NodeCrypto.createHash("sha256").update(token).digest();
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
          UPDATE organization_invitations
          SET revoked_at = now()
          WHERE organization_id = ${input.organizationId}
            AND lower(email) = ${email}
            AND accepted_at IS NULL AND revoked_at IS NULL
        `;
          const rows = yield* sql<{ readonly expires_at: Date }>`
          INSERT INTO organization_invitations (
            id, organization_id, email, role, token_hash,
            invited_by_principal_id, expires_at
          ) VALUES (
            ${input.invitationId}, ${input.organizationId}, ${email}, ${input.role},
            ${tokenHash}, ${input.invitedByPrincipalId},
            now() + (${expiresInSeconds} * interval '1 second')
          )
          RETURNING expires_at
        `;
          const expiresAt = rows[0]?.expires_at;
          if (expiresAt === undefined) {
            return yield* new InvitationRepositoryError({ reason: "persistence_failed" });
          }
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, source_ip, metadata
          ) VALUES (
            ${input.requestId}, ${input.invitedByPrincipalId}, ${input.organizationId},
            'organization.invitation.create', 'organization_invitation',
            ${input.invitationId}, 'allowed', ${input.sourceIp ?? null},
            ${sql.json({ email, role: input.role, expiresInSeconds })}
          )
        `;
          return { token, expiresAt };
        }),
      )
      .pipe(Effect.mapError(persistenceError));
  });

  const revoke: InvitationRepository["Service"]["revoke"] = Effect.fn(
    "InvitationRepository.revoke",
  )(function* (invitationId, organizationId, actorPrincipalId, requestId) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly id: string }>`
          UPDATE organization_invitations
          SET revoked_at = now()
          WHERE id = ${invitationId} AND organization_id = ${organizationId}
            AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING id
        `;
          if (rows.length !== 1) {
            return yield* new InvitationRepositoryError({ reason: "invitation_not_found" });
          }
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result
          ) VALUES (
            ${requestId}, ${actorPrincipalId}, ${organizationId},
            'organization.invitation.revoke', 'organization_invitation',
            ${invitationId}, 'allowed'
          )
        `;
        }),
      )
      .pipe(Effect.mapError(persistenceError));
  });

  return InvitationRepository.of({ create, revoke });
});

export const layer = Layer.effect(InvitationRepository, make);
