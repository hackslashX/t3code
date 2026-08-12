import * as PgClient from "@effect/sql-pg/PgClient";
import { OrganizationId, type OrganizationRole, type PrincipalId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { OidcIdentity } from "./OidcProvider.ts";

export class IdentityRepositoryError extends Schema.TaggedErrorClass<IdentityRepositoryError>()(
  "IdentityRepositoryError",
  {
    reason: Schema.Literals([
      "invitation_required",
      "verified_email_required",
      "principal_suspended",
      "organization_unavailable",
      "persistence_failed",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface ResolvedIdentity {
  readonly principalId: PrincipalId;
  readonly enrolled: boolean;
  readonly organizationId?: OrganizationId;
  readonly role?: OrganizationRole;
}

export interface EnrollIdentityInput {
  readonly identity: OidcIdentity;
  readonly invitationToken?: string;
  readonly principalId: PrincipalId;
  readonly externalIdentityId: string;
  readonly requestId: string;
  readonly sourceIp?: string;
}

export class IdentityRepository extends Context.Service<
  IdentityRepository,
  {
    readonly resolveOrEnroll: (
      input: EnrollIdentityInput,
    ) => Effect.Effect<ResolvedIdentity, IdentityRepositoryError>;
  }
>()("@t3tools/control-plane/IdentityRepository") {}

const hashToken = (token: string) => NodeCrypto.createHash("sha256").update(token).digest();
const defaultOrganizationQuota = {
  maxWorkspaces: 20,
  maxRunningWorkspaces: 10,
  maxCpuMillis: 32_000,
  maxMemoryBytes: 128 * 1024 ** 3,
  maxStorageBytes: 2 * 1024 ** 4,
} as const;
const organizationSlug = (email: string, organizationId: string) => {
  const localPart = email.split("@", 1)[0] ?? "team";
  const base = localPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "team"}-${organizationId.slice(0, 8)}`.slice(0, 63);
};
const persistenceError = (cause: unknown) =>
  Schema.is(IdentityRepositoryError)(cause)
    ? cause
    : new IdentityRepositoryError({ reason: "persistence_failed", cause });

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;

  const resolveOrEnroll: IdentityRepository["Service"]["resolveOrEnroll"] = Effect.fn(
    "IdentityRepository.resolveOrEnroll",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existingRows = yield* sql<{
            readonly principal_id: PrincipalId;
            readonly status: "active" | "suspended";
          }>`
          SELECT identities.principal_id, principals.status
          FROM external_identities AS identities
          JOIN principals ON principals.id = identities.principal_id
          WHERE identities.issuer = ${input.identity.issuer}
            AND identities.subject = ${input.identity.subject}
          FOR UPDATE OF principals
        `;
          const existing = existingRows[0];
          if (existing !== undefined) {
            if (existing.status !== "active") {
              return yield* new IdentityRepositoryError({ reason: "principal_suspended" });
            }
            yield* sql`
            UPDATE principals
            SET display_name = ${input.identity.displayName ?? input.identity.email ?? input.identity.subject},
                email = coalesce(${
                  input.identity.emailVerified !== false ? (input.identity.email ?? null) : null
                }, email),
                avatar_url = ${input.identity.avatarUrl ?? null}, updated_at = now()
            WHERE id = ${existing.principal_id}
          `;
            return { principalId: existing.principal_id, enrolled: false };
          }

          // Some enterprise OIDC providers omit email_verified because the directory is authoritative.
          // Reject an explicit false claim while accepting a present email when the claim is absent.
          if (input.identity.email === undefined || input.identity.emailVerified === false) {
            return yield* new IdentityRepositoryError({ reason: "verified_email_required" });
          }
          // The first identity creates the initial organization. The transaction lock elects
          // exactly one owner when two people complete first sign-in together.
          yield* sql`SELECT pg_advisory_xact_lock(hashtext('t3-hosted-control-plane-onboarding'))`;
          const organizations = yield* sql<{ readonly exists: boolean }>`
            SELECT EXISTS (SELECT 1 FROM organizations) AS exists
          `;
          if (!organizations[0]?.exists) {
            const organizationId = OrganizationId.make(NodeCrypto.randomUUID());
            const displayName = input.identity.displayName ?? input.identity.email;
            yield* sql`
              INSERT INTO principals (id, display_name, email, avatar_url, status)
              VALUES (${input.principalId}, ${displayName}, ${input.identity.email}, ${input.identity.avatarUrl ?? null}, 'active')
            `;
            yield* sql`
              INSERT INTO external_identities (id, principal_id, issuer, subject)
              VALUES (${input.externalIdentityId}, ${input.principalId}, ${input.identity.issuer}, ${input.identity.subject})
            `;
            yield* sql`
              INSERT INTO organizations (id, slug, name, status)
              VALUES (${organizationId}, ${organizationSlug(input.identity.email, organizationId)}, ${`${displayName}'s organization`}, 'active')
            `;
            yield* sql`
              INSERT INTO organization_memberships (organization_id, principal_id, role, status)
              VALUES (${organizationId}, ${input.principalId}, 'owner', 'active')
            `;
            yield* sql`
              INSERT INTO organization_quotas (
                organization_id, max_workspaces, max_running_workspaces, max_cpu_millis,
                max_memory_bytes, max_storage_bytes
              ) VALUES (
                ${organizationId}, ${defaultOrganizationQuota.maxWorkspaces}, ${defaultOrganizationQuota.maxRunningWorkspaces},
                ${defaultOrganizationQuota.maxCpuMillis}, ${defaultOrganizationQuota.maxMemoryBytes},
                ${defaultOrganizationQuota.maxStorageBytes}
              )
            `;
            yield* sql`
              INSERT INTO audit_events (
                request_id, actor_principal_id, organization_id, action,
                resource_type, resource_id, result, source_ip, metadata
              ) VALUES (
                ${input.requestId}, ${input.principalId}, ${organizationId}, 'organization.onboard',
                'organization', ${organizationId}, 'allowed', ${input.sourceIp ?? null}, ${sql.json({ issuer: input.identity.issuer })}
              )
            `;
            return {
              principalId: input.principalId,
              enrolled: true,
              organizationId,
              role: "owner" as const,
            };
          }
          if (input.invitationToken === undefined || input.invitationToken.length === 0) {
            return yield* new IdentityRepositoryError({ reason: "invitation_required" });
          }
          const invitations = yield* sql<{
            readonly id: string;
            readonly organization_id: OrganizationId;
            readonly role: OrganizationRole;
          }>`
          SELECT invitations.id, invitations.organization_id, invitations.role
          FROM organization_invitations AS invitations
          JOIN organizations ON organizations.id = invitations.organization_id
          WHERE invitations.token_hash = ${hashToken(input.invitationToken)}
            AND lower(invitations.email) = lower(${input.identity.email})
            AND invitations.accepted_at IS NULL
            AND invitations.revoked_at IS NULL
            AND invitations.expires_at > now()
            AND organizations.status = 'active'
          FOR UPDATE OF invitations
        `;
          const invitation = invitations[0];
          if (invitation === undefined) {
            return yield* new IdentityRepositoryError({ reason: "invitation_required" });
          }

          yield* sql`
          INSERT INTO principals (id, display_name, email, avatar_url, status)
          VALUES (
            ${input.principalId},
            ${input.identity.displayName ?? input.identity.email},
            ${input.identity.email}, ${input.identity.avatarUrl ?? null}, 'active'
          )
        `;
          yield* sql`
          INSERT INTO external_identities (id, principal_id, issuer, subject)
          VALUES (
            ${input.externalIdentityId}, ${input.principalId},
            ${input.identity.issuer}, ${input.identity.subject}
          )
        `;
          yield* sql`
          INSERT INTO organization_memberships (
            organization_id, principal_id, role, status
          ) VALUES (
            ${invitation.organization_id}, ${input.principalId}, ${invitation.role}, 'active'
          )
        `;
          yield* sql`
          UPDATE organization_invitations SET accepted_at = now()
          WHERE id = ${invitation.id}
        `;
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, source_ip, metadata
          ) VALUES (
            ${input.requestId}, ${input.principalId}, ${invitation.organization_id},
            'organization.invitation.accept', 'organization_invitation',
            ${invitation.id}, 'allowed', ${input.sourceIp ?? null},
            ${sql.json({ issuer: input.identity.issuer, role: invitation.role })}
          )
        `;
          return {
            principalId: input.principalId,
            enrolled: true,
            organizationId: invitation.organization_id,
            role: invitation.role,
          };
        }),
      )
      .pipe(Effect.mapError(persistenceError));
  });

  return IdentityRepository.of({ resolveOrEnroll });
});

export const layer = Layer.effect(IdentityRepository, make);
