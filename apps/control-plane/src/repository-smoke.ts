import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import {
  CreateWorkspaceRequest,
  DeleteWorkspaceRequest,
  OrganizationId,
  PrincipalId,
  UpdateWorkspaceDesiredStateRequest,
  WorkspaceId,
  WorkspaceVolumeId,
} from "@t3tools/hosted-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as BrowserSessionStore from "./BrowserSessionStore.ts";
import * as Database from "./Database.ts";
import * as IdentityQuery from "./IdentityQuery.ts";
import * as IdentityRepository from "./IdentityRepository.ts";
import * as InvitationRepository from "./InvitationRepository.ts";
import { runMigrations } from "./Migrations.ts";
import * as OrganizationAuthorization from "./OrganizationAuthorization.ts";
import * as OutboxRepository from "./OutboxRepository.ts";
import * as WorkspaceRepository from "./WorkspaceRepository.ts";
import * as WorkspaceStatusRepository from "./WorkspaceStatusRepository.ts";
import * as WorkspaceVolumeRepository from "./WorkspaceVolumeRepository.ts";

const failUnless = (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.die(new Error(message));

const program = Effect.gen(function* () {
  yield* runMigrations();
  const sql = yield* PgClient.PgClient;
  const repository = yield* WorkspaceRepository.WorkspaceRepository;
  const browserSessions = yield* BrowserSessionStore.BrowserSessionStore;
  const identities = yield* IdentityRepository.IdentityRepository;
  const identityQuery = yield* IdentityQuery.IdentityQuery;
  const invitations = yield* InvitationRepository.InvitationRepository;
  const authorization = yield* OrganizationAuthorization.OrganizationAuthorization;
  const outbox = yield* OutboxRepository.OutboxRepository;
  const workspaceStatuses = yield* WorkspaceStatusRepository.WorkspaceStatusRepository;
  const workspaceVolumes = yield* WorkspaceVolumeRepository.WorkspaceVolumeRepository;
  yield* sql.unsafe(`
    TRUNCATE outbox_events, audit_events, workspace_conditions, workspaces,
      workspace_volumes, organization_quotas, organization_memberships,
      organization_invitations, external_identities, organizations, principals
    CASCADE
  `);

  const principalId = PrincipalId.make("00000000-0000-0000-0000-000000000001");
  const organizationId = OrganizationId.make("00000000-0000-0000-0000-000000000010");
  const workspaceId = WorkspaceId.make("00000000-0000-0000-0000-000000000020");
  const volumeId = WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000030");
  yield* sql`
    INSERT INTO principals (id, display_name, email, status)
    VALUES (${principalId}, 'Test User', 'test@example.test', 'active')
  `;
  yield* sql`
    INSERT INTO organizations (id, slug, name, status)
    VALUES (${organizationId}, 'test-org', 'Test Org', 'active')
  `;
  yield* sql`
    INSERT INTO organization_memberships (organization_id, principal_id, role, status)
    VALUES (${organizationId}, ${principalId}, 'owner', 'active')
  `;
  yield* sql`
    INSERT INTO organization_quotas (
      organization_id, max_workspaces, max_running_workspaces,
      max_cpu_millis, max_memory_bytes, max_storage_bytes
    ) VALUES (${organizationId}, 2, 1, 4000, 8589934592, 21474836480)
  `;

  const request = yield* Schema.decodeUnknownEffect(CreateWorkspaceRequest)({
    name: "Development",
    imageProfile: "stable",
    resources: {
      cpuRequestMillis: 500,
      cpuLimitMillis: 2000,
      memoryRequestBytes: 1073741824,
      memoryLimitBytes: 4294967296,
      ephemeralStorageBytes: 2147483648,
    },
    storage: {
      kind: "new",
      storageClass: "longhorn-ssd-orion",
      requestedBytes: 10737418240,
      accessMode: "ReadWriteOnce",
      retentionPolicy: "retain",
    },
    egressProfile: "restricted",
  });
  yield* repository.create({
    workspaceId,
    organizationId,
    ownerPrincipalId: principalId,
    slug: "development",
    request,
    volumeId,
    requestId: "request-create",
  });

  yield* workspaceVolumes.recordPvcUid(volumeId, "pvc-uid-workspace-30");
  const volumeUidRows = yield* sql<{ readonly kubernetes_pvc_uid: string | null }>`
    SELECT kubernetes_pvc_uid FROM workspace_volumes WHERE id = ${volumeId}
  `;
  yield* failUnless(
    volumeUidRows[0]?.kubernetes_pvc_uid === "pvc-uid-workspace-30",
    "provisioned PVC UID was not persisted",
  );

  const createdRows = yield* sql<{ readonly count: string }>`
    SELECT count(*)::text AS count FROM workspaces WHERE id = ${workspaceId}
  `;
  const outboxRows = yield* sql<{ readonly count: string }>`
    SELECT count(*)::text AS count FROM outbox_events WHERE aggregate_id = ${workspaceId}
  `;
  yield* failUnless(createdRows[0]?.count === "1", "workspace was not created");
  yield* failUnless(outboxRows[0]?.count === "1", "workspace create outbox event missing");

  const start = yield* Schema.decodeUnknownEffect(UpdateWorkspaceDesiredStateRequest)({
    desiredState: "Running",
    expectedGeneration: 0,
  });
  const started = yield* repository.updateDesiredState(
    workspaceId,
    organizationId,
    principalId,
    "request-start",
    start,
  );
  yield* failUnless(started.changed && started.generation === 1, "workspace did not start");
  const statusTransitionAt = DateTime.toDate(DateTime.makeUnsafe("2026-06-01T00:00:00.000Z"));
  yield* workspaceStatuses.project({
    workspaceId,
    organizationId,
    observedWorkspaceGeneration: 1,
    phase: "Ready",
    environmentId: "environment-workspace-20",
    routeHost: "workspace-20.example.test",
    conditions: [
      {
        type: "StorageReady",
        status: "True",
        reason: "VolumeBound",
        message: "Workspace volume is bound.",
        observedGeneration: 1,
        lastTransitionAt: statusTransitionAt,
      },
      {
        type: "PodReady",
        status: "True",
        reason: "ContainersReady",
        message: "Workspace containers are ready.",
        observedGeneration: 1,
        lastTransitionAt: statusTransitionAt,
      },
    ],
  });
  const projectedStatus = yield* sql<{
    readonly phase: string;
    readonly observed_generation: string | number;
    readonly volume_status: string;
  }>`
    SELECT workspaces.phase, workspaces.observed_generation,
           volumes.status AS volume_status
    FROM workspaces JOIN workspace_volumes AS volumes ON volumes.id = workspaces.volume_id
    WHERE workspaces.id = ${workspaceId}
  `;
  yield* failUnless(
    projectedStatus[0]?.phase === "Ready" &&
      Number(projectedStatus[0]?.observed_generation) === 1 &&
      projectedStatus[0]?.volume_status === "attached",
    "operator status was not projected into PostgreSQL",
  );

  const repeated = yield* repository.updateDesiredState(
    workspaceId,
    organizationId,
    principalId,
    "request-start-repeat",
    { desiredState: "Running", expectedGeneration: 1 },
  );
  yield* failUnless(!repeated.changed && repeated.generation === 1, "start was not idempotent");

  const stale = yield* Effect.exit(
    repository.updateDesiredState(workspaceId, organizationId, principalId, "request-stale", {
      desiredState: "Stopped",
      expectedGeneration: 0,
    }),
  );
  yield* failUnless(stale._tag === "Failure", "stale generation was accepted");

  const quotaRace = yield* Effect.all(
    [
      repository
        .create({
          workspaceId: WorkspaceId.make("00000000-0000-0000-0000-000000000021"),
          organizationId,
          ownerPrincipalId: principalId,
          slug: "quota-race-a",
          request: {
            ...request,
            name: "Quota Race A",
            storage: {
              kind: "new",
              storageClass: "longhorn-ssd-orion",
              requestedBytes: 1073741824,
              accessMode: "ReadWriteOnce",
              retentionPolicy: "retain",
            },
          },
          volumeId: WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000031"),
          requestId: "request-quota-race-a",
        })
        .pipe(Effect.exit),
      repository
        .create({
          workspaceId: WorkspaceId.make("00000000-0000-0000-0000-000000000022"),
          organizationId,
          ownerPrincipalId: principalId,
          slug: "quota-race-b",
          request: {
            ...request,
            name: "Quota Race B",
            storage: {
              kind: "new",
              storageClass: "longhorn-ssd-orion",
              requestedBytes: 1073741824,
              accessMode: "ReadWriteOnce",
              retentionPolicy: "retain",
            },
          },
          volumeId: WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000032"),
          requestId: "request-quota-race-b",
        })
        .pipe(Effect.exit),
    ],
    { concurrency: "unbounded" },
  );
  yield* failUnless(
    quotaRace.filter((exit) => exit._tag === "Success").length === 1,
    "concurrent creates exceeded the workspace quota",
  );

  yield* sql`
    UPDATE organization_quotas
    SET max_workspaces = 4, max_running_workspaces = 2,
        max_cpu_millis = 8000, max_memory_bytes = 17179869184
    WHERE organization_id = ${organizationId}
  `;
  const sharedVolumeId = WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000033");
  yield* sql`
    INSERT INTO workspace_volumes (
      id, organization_id, kubernetes_pvc_uid, kubernetes_pvc_name,
      storage_class, capacity_bytes, access_mode, source, status, retention_policy
    ) VALUES (
      ${sharedVolumeId}, ${organizationId}, 'pvc-uid-shared', 'shared-existing',
      'longhorn-ssd-orion', 1073741824, 'ReadWriteOnce', 'imported', 'available', 'retain'
    )
  `;
  const existingStorageRequest = {
    ...request,
    storage: { kind: "existing" as const, volumeId: sharedVolumeId },
  };
  const volumeRace = yield* Effect.all(
    [
      repository
        .create({
          workspaceId: WorkspaceId.make("00000000-0000-0000-0000-000000000023"),
          organizationId,
          ownerPrincipalId: principalId,
          slug: "volume-race-a",
          request: { ...existingStorageRequest, name: "Volume Race A" },
          volumeId: WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000034"),
          requestId: "request-volume-race-a",
        })
        .pipe(Effect.exit),
      repository
        .create({
          workspaceId: WorkspaceId.make("00000000-0000-0000-0000-000000000024"),
          organizationId,
          ownerPrincipalId: principalId,
          slug: "volume-race-b",
          request: { ...existingStorageRequest, name: "Volume Race B" },
          volumeId: WorkspaceVolumeId.make("00000000-0000-0000-0000-000000000035"),
          requestId: "request-volume-race-b",
        })
        .pipe(Effect.exit),
    ],
    { concurrency: "unbounded" },
  );
  yield* failUnless(
    volumeRace.filter((exit) => exit._tag === "Success").length === 1,
    "one existing volume was attached to multiple workspaces",
  );

  const auditRows = yield* sql<{ readonly count: string }>`
    SELECT count(*)::text AS count FROM audit_events WHERE resource_id = ${workspaceId}
  `;
  yield* failUnless(auditRows[0]?.count === "2", "expected create and start audit events");

  yield* authorization.authorize(principalId, organizationId, "organization.manage");
  const identitySummary = yield* identityQuery.get(principalId);
  yield* failUnless(
    identitySummary.organizations.length === 1 &&
      identitySummary.organizations[0]?.role === "owner",
    "identity organization query was not scoped to active memberships",
  );

  const invitedPrincipalId = PrincipalId.make("00000000-0000-0000-0000-000000000002");
  const issuedInvitation = yield* invitations.create({
    invitationId: "00000000-0000-0000-0000-000000000040",
    organizationId,
    email: "invited@example.test",
    role: "viewer",
    invitedByPrincipalId: principalId,
    expiresInSeconds: 3600,
    requestId: "request-invite",
  });
  const invitationToken = issuedInvitation.token;
  const enrolled = yield* identities.resolveOrEnroll({
    identity: {
      issuer: "https://issuer.example.test",
      subject: "subject-invited",
      email: "invited@example.test",
      emailVerified: true,
      displayName: "Invited User",
    },
    invitationToken,
    principalId: invitedPrincipalId,
    externalIdentityId: "00000000-0000-0000-0000-000000000050",
    requestId: "request-enroll",
  });
  yield* failUnless(enrolled.enrolled && enrolled.role === "viewer", "invitation was not accepted");
  yield* authorization.authorize(invitedPrincipalId, organizationId, "workspace.read");
  const deniedCreate = yield* Effect.exit(
    authorization.authorize(invitedPrincipalId, organizationId, "workspace.create"),
  );
  yield* failUnless(deniedCreate._tag === "Failure", "viewer was allowed to create a workspace");
  const resolvedAgain = yield* identities.resolveOrEnroll({
    identity: {
      issuer: "https://issuer.example.test",
      subject: "subject-invited",
      email: "invited@example.test",
      emailVerified: true,
      displayName: "Updated Invited User",
    },
    principalId: PrincipalId.make("00000000-0000-0000-0000-000000000099"),
    externalIdentityId: "00000000-0000-0000-0000-000000000098",
    requestId: "request-resolve-existing",
  });
  yield* failUnless(
    !resolvedAgain.enrolled && resolvedAgain.principalId === invitedPrincipalId,
    "existing external identity was not resolved",
  );

  const issuedSession = yield* browserSessions.issue(principalId, { ttlSeconds: 60 });
  const verifiedSession = yield* browserSessions.verify(issuedSession.token);
  yield* failUnless(
    verifiedSession.principalId === principalId,
    "browser session did not resolve its principal",
  );
  const storedSessions = yield* sql<{ readonly token_hash: string }>`
    SELECT encode(id_hash, 'hex') AS token_hash FROM web_sessions
  `;
  yield* failUnless(
    storedSessions.length === 1 && storedSessions[0]?.token_hash !== issuedSession.token,
    "raw browser session token was persisted",
  );
  const claimed = yield* Effect.all([outbox.claimNext("worker-a"), outbox.claimNext("worker-b")], {
    concurrency: "unbounded",
  });
  const firstClaim = claimed[0];
  const secondClaim = claimed[1];
  yield* failUnless(
    firstClaim?._tag === "Some" &&
      secondClaim?._tag === "Some" &&
      firstClaim.value.id !== secondClaim.value.id,
    "concurrent outbox workers claimed the same event",
  );
  if (firstClaim?._tag === "Some") yield* outbox.complete("worker-a", firstClaim.value.id);
  if (secondClaim?._tag === "Some") yield* outbox.complete("worker-b", secondClaim.value.id);

  yield* browserSessions.revoke(issuedSession.token);
  const revoked = yield* Effect.exit(browserSessions.verify(issuedSession.token));
  yield* failUnless(revoked._tag === "Failure", "revoked browser session remained valid");

  const deletion = yield* repository.delete(
    workspaceId,
    organizationId,
    principalId,
    "request-delete",
    yield* Schema.decodeUnknownEffect(DeleteWorkspaceRequest)({
      volumePolicy: "retain",
      expectedGeneration: 1,
    }),
  );
  yield* failUnless(deletion.generation === 2, "workspace deletion generation was not advanced");
  const deletedRows = yield* sql<{
    readonly phase: string;
    readonly deleted: boolean;
    readonly volume_status: string;
  }>`
    SELECT workspaces.phase, workspaces.deleted_at IS NOT NULL AS deleted,
           volumes.status AS volume_status
    FROM workspaces JOIN workspace_volumes AS volumes ON volumes.id = workspaces.volume_id
    WHERE workspaces.id = ${workspaceId}
  `;
  yield* failUnless(
    deletedRows[0]?.phase === "Deleting" &&
      deletedRows[0]?.deleted === true &&
      deletedRows[0]?.volume_status === "deleting",
    "workspace deletion was not committed atomically",
  );
  yield* workspaceVolumes.finalizeDeletion(volumeId, "retain");
  const retainedRows = yield* sql<{
    readonly status: string;
    readonly attached_workspace_id: string | null;
  }>`
    SELECT status, attached_workspace_id FROM workspace_volumes WHERE id = ${volumeId}
  `;
  yield* failUnless(
    retainedRows[0]?.status === "available" && retainedRows[0]?.attached_workspace_id === null,
    "retained volume was not released",
  );
  yield* Effect.logInfo(
    "Workspace, identity, authorization, and browser session smoke test passed.",
  );
});

const DatabaseLayer = Database.layer.pipe(Layer.provideMerge(NodeServices.layer));
const RuntimeLayer = Layer.mergeAll(
  WorkspaceRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  BrowserSessionStore.layer.pipe(Layer.provide(DatabaseLayer)),
  IdentityRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  IdentityQuery.layer.pipe(Layer.provide(DatabaseLayer)),
  InvitationRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  OrganizationAuthorization.layer.pipe(Layer.provide(DatabaseLayer)),
  OutboxRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  WorkspaceStatusRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  WorkspaceVolumeRepository.layer.pipe(Layer.provide(DatabaseLayer)),
).pipe(Layer.provideMerge(DatabaseLayer));

if (import.meta.main) {
  program.pipe(Effect.provide(RuntimeLayer), Effect.scoped, NodeRuntime.runMain);
}
