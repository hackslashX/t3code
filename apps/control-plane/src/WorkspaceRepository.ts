import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type CreateWorkspaceRequest,
  type DeleteWorkspaceRequest,
  type OrganizationId,
  type PrincipalId,
  type UpdateWorkspaceDesiredStateRequest,
  type WorkspaceId,
  type WorkspaceVolumeId,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceCatalog from "./WorkspaceCatalog.ts";

export const WorkspaceRepositoryErrorReason = Schema.Literals([
  "organization_quota_missing",
  "workspace_quota_exceeded",
  "running_workspace_quota_exceeded",
  "cpu_quota_exceeded",
  "memory_quota_exceeded",
  "storage_quota_exceeded",
  "volume_not_available",
  "workspace_not_found",
  "stale_generation",
  "image_already_current",
  "imported_volume_delete_forbidden",
  "persistence_failed",
]);
export type WorkspaceRepositoryErrorReason = typeof WorkspaceRepositoryErrorReason.Type;

export class WorkspaceRepositoryError extends Schema.TaggedErrorClass<WorkspaceRepositoryError>()(
  "WorkspaceRepositoryError",
  {
    reason: WorkspaceRepositoryErrorReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface CreateWorkspaceRecordInput {
  readonly workspaceId: WorkspaceId;
  readonly organizationId: OrganizationId;
  readonly ownerPrincipalId: PrincipalId;
  readonly slug: string;
  readonly request: CreateWorkspaceRequest;
  readonly volumeId: WorkspaceVolumeId;
  readonly requestId: string;
  readonly sourceIp?: string;
}

export interface WorkspaceDeletionResult {
  readonly workspaceId: WorkspaceId;
  readonly generation: number;
}

export interface WorkspaceMigrationResult {
  readonly workspaceId: WorkspaceId;
  readonly generation: number;
  readonly imageRevision: string;
  readonly changed: boolean;
}

export interface WorkspaceDesiredStateResult {
  readonly workspaceId: WorkspaceId;
  readonly desiredState: "Running" | "Stopped";
  readonly generation: number;
  readonly changed: boolean;
}

export class WorkspaceRepository extends Context.Service<
  WorkspaceRepository,
  {
    readonly create: (
      input: CreateWorkspaceRecordInput,
    ) => Effect.Effect<void, WorkspaceRepositoryError>;
    readonly delete: (
      workspaceId: WorkspaceId,
      organizationId: OrganizationId,
      actorPrincipalId: PrincipalId,
      requestId: string,
      request: DeleteWorkspaceRequest,
    ) => Effect.Effect<WorkspaceDeletionResult, WorkspaceRepositoryError>;
    readonly migrateImage: (
      workspaceId: WorkspaceId,
      organizationId: OrganizationId,
      actorPrincipalId: PrincipalId,
      requestId: string,
      expectedGeneration: number,
    ) => Effect.Effect<WorkspaceMigrationResult, WorkspaceRepositoryError>;
    readonly updateDesiredState: (
      workspaceId: WorkspaceId,
      organizationId: OrganizationId,
      actorPrincipalId: PrincipalId,
      requestId: string,
      request: UpdateWorkspaceDesiredStateRequest,
    ) => Effect.Effect<WorkspaceDesiredStateResult, WorkspaceRepositoryError>;
  }
>()("@t3tools/control-plane/WorkspaceRepository") {}

interface QuotaRow {
  readonly max_workspaces: string | number;
  readonly max_running_workspaces: string | number;
  readonly max_cpu_millis: string | number;
  readonly max_memory_bytes: string | number;
  readonly max_storage_bytes: string | number;
}

interface UsageRow {
  readonly workspace_count: string | number;
  readonly running_workspace_count: string | number;
  readonly cpu_millis: string | number;
  readonly memory_bytes: string | number;
  readonly storage_bytes: string | number;
}

const numberValue = (value: string | number | undefined) => Number(value ?? 0);
const fail = (reason: WorkspaceRepositoryErrorReason) =>
  Effect.fail(new WorkspaceRepositoryError({ reason }));
const mapPersistenceError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((cause) =>
      Schema.is(WorkspaceRepositoryError)(cause)
        ? cause
        : new WorkspaceRepositoryError({ reason: "persistence_failed", cause }),
    ),
  );

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const catalog = yield* WorkspaceCatalog.WorkspaceCatalog;

  const create: WorkspaceRepository["Service"]["create"] = Effect.fn("WorkspaceRepository.create")(
    function* (input) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const quotaRows = yield* sql<QuotaRow>`
          SELECT max_workspaces, max_running_workspaces, max_cpu_millis,
                 max_memory_bytes, max_storage_bytes
          FROM organization_quotas
          WHERE organization_id = ${input.organizationId}
          FOR UPDATE
        `;
            const quota = quotaRows[0];
            if (quota === undefined) return yield* fail("organization_quota_missing");

            const usageRows = yield* sql<UsageRow>`
          SELECT
            (SELECT count(*) FROM workspaces
             WHERE organization_id = ${input.organizationId} AND deleted_at IS NULL)
              AS workspace_count,
            (SELECT count(*) FROM workspaces
             WHERE organization_id = ${input.organizationId}
               AND deleted_at IS NULL AND desired_state = 'Running')
              AS running_workspace_count,
            (SELECT coalesce(sum(cpu_limit_millis), 0) FROM workspaces
             WHERE organization_id = ${input.organizationId} AND deleted_at IS NULL)
              AS cpu_millis,
            (SELECT coalesce(sum(memory_limit_bytes), 0) FROM workspaces
             WHERE organization_id = ${input.organizationId} AND deleted_at IS NULL)
              AS memory_bytes,
            (SELECT coalesce(sum(capacity_bytes), 0) FROM workspace_volumes
             WHERE organization_id = ${input.organizationId} AND status <> 'deleting')
              AS storage_bytes
        `;
            const usage = usageRows[0];
            if (numberValue(usage?.workspace_count) + 1 > numberValue(quota.max_workspaces)) {
              return yield* fail("workspace_quota_exceeded");
            }
            if (
              numberValue(usage?.cpu_millis) + input.request.resources.cpuLimitMillis >
              numberValue(quota.max_cpu_millis)
            ) {
              return yield* fail("cpu_quota_exceeded");
            }
            if (
              numberValue(usage?.memory_bytes) + input.request.resources.memoryLimitBytes >
              numberValue(quota.max_memory_bytes)
            ) {
              return yield* fail("memory_quota_exceeded");
            }

            if (input.request.storage.kind === "new") {
              if (
                numberValue(usage?.storage_bytes) + input.request.storage.requestedBytes >
                numberValue(quota.max_storage_bytes)
              ) {
                return yield* fail("storage_quota_exceeded");
              }
              yield* sql`
            INSERT INTO workspace_volumes (
              id, organization_id, kubernetes_pvc_name, storage_class,
              capacity_bytes, access_mode, source, status, retention_policy
            ) VALUES (
              ${input.volumeId}, ${input.organizationId}, ${`ws-${input.workspaceId}`},
              ${input.request.storage.storageClass}, ${input.request.storage.requestedBytes},
              ${input.request.storage.accessMode}, 'created', 'provisioning',
              ${input.request.storage.retentionPolicy}
            )
          `;
            } else {
              const reserved = yield* sql<{ readonly id: string }>`
            UPDATE workspace_volumes
            SET status = 'attached', updated_at = now()
            WHERE id = ${input.request.storage.volumeId}
              AND organization_id = ${input.organizationId}
              AND status = 'available'
              AND attached_workspace_id IS NULL
            RETURNING id
          `;
              if (reserved.length !== 1) return yield* fail("volume_not_available");
            }

            const volumeId =
              input.request.storage.kind === "new"
                ? input.volumeId
                : input.request.storage.volumeId;
            yield* sql`
          INSERT INTO workspaces (
            id, organization_id, owner_principal_id, name, slug, desired_state, phase,
            node_name, environment_id, image_profile, image_revision, cpu_request_millis, cpu_limit_millis,
            memory_request_bytes, memory_limit_bytes, ephemeral_storage_bytes,
            gpu_class, gpu_count, egress_profile, volume_id
          ) VALUES (
            ${input.workspaceId}, ${input.organizationId}, ${input.ownerPrincipalId},
            ${input.request.name}, ${input.slug}, 'Stopped', 'Stopped',
            ${input.request.nodeName}, gen_random_uuid()::text,
            ${input.request.imageProfile}, ${catalog.imageProfiles.get(input.request.imageProfile)?.revision ?? "legacy"}, ${input.request.resources.cpuRequestMillis},
            ${input.request.resources.cpuLimitMillis},
            ${input.request.resources.memoryRequestBytes},
            ${input.request.resources.memoryLimitBytes},
            ${input.request.resources.ephemeralStorageBytes},
            ${input.request.resources.gpu?.className ?? null},
            ${input.request.resources.gpu?.count ?? null}, ${input.request.egressProfile},
            ${volumeId}
          )
        `;
            yield* sql`
          UPDATE workspace_volumes
          SET attached_workspace_id = ${input.workspaceId},
              status = CASE WHEN status = 'available' THEN 'attached' ELSE status END,
              updated_at = now()
          WHERE id = ${volumeId} AND organization_id = ${input.organizationId}
        `;
            yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, source_ip, metadata
          ) VALUES (
            ${input.requestId}, ${input.ownerPrincipalId}, ${input.organizationId},
            'workspace.create', 'workspace', ${input.workspaceId}, 'allowed',
            ${input.sourceIp ?? null}, ${sql.json({ desiredState: "Stopped" })}
          )
        `;
            yield* sql`
          INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
          VALUES (
            'workspace', ${input.workspaceId}, 'workspace.created',
            ${sql.json({ workspaceId: input.workspaceId, generation: 0 })}
          )
        `;
          }),
        )
        .pipe(mapPersistenceError);
    },
  );

  const migrateImage: WorkspaceRepository["Service"]["migrateImage"] = Effect.fn(
    "WorkspaceRepository.migrateImage",
  )(function* (workspaceId, organizationId, actorPrincipalId, requestId, expectedGeneration) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly generation: string | number;
            readonly image_profile: string;
            readonly image_revision: string;
          }>`
        SELECT generation, image_profile, image_revision FROM workspaces
        WHERE id = ${workspaceId} AND organization_id = ${organizationId} AND deleted_at IS NULL FOR UPDATE
      `;
          const workspace = rows[0];
          if (workspace === undefined) return yield* fail("workspace_not_found");
          const generation = numberValue(workspace.generation);
          if (generation !== expectedGeneration) return yield* fail("stale_generation");
          const profile = catalog.imageProfiles.get(workspace.image_profile);
          if (profile === undefined || profile.revision === workspace.image_revision) {
            return {
              workspaceId,
              generation,
              imageRevision: workspace.image_revision,
              changed: false,
            };
          }
          const nextGeneration = generation + 1;
          yield* sql`
        UPDATE workspaces SET image_revision = ${profile.revision}, generation = ${nextGeneration},
          phase = CASE WHEN desired_state = 'Running' THEN 'Starting' ELSE phase END, updated_at = now()
        WHERE id = ${workspaceId}
      `;
          yield* sql`
        INSERT INTO audit_events (request_id, actor_principal_id, organization_id, action, resource_type, resource_id, result, metadata)
        VALUES (${requestId}, ${actorPrincipalId}, ${organizationId}, 'workspace.image.migrate', 'workspace', ${workspaceId}, 'allowed',
          ${sql.json({ imageProfile: profile.id, imageRevision: profile.revision, generation: nextGeneration })})
      `;
          yield* sql`
        INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
        VALUES ('workspace', ${workspaceId}, 'workspace.image.migrated',
          ${sql.json({ workspaceId, generation: nextGeneration, imageRevision: profile.revision })})
      `;
          return {
            workspaceId,
            generation: nextGeneration,
            imageRevision: profile.revision,
            changed: true,
          };
        }),
      )
      .pipe(mapPersistenceError);
  });

  const updateDesiredState: WorkspaceRepository["Service"]["updateDesiredState"] = Effect.fn(
    "WorkspaceRepository.updateDesiredState",
  )(function* (workspaceId, organizationId, actorPrincipalId, requestId, request) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly desired_state: "Running" | "Stopped";
            readonly generation: string | number;
          }>`
          SELECT desired_state, generation
          FROM workspaces
          WHERE id = ${workspaceId} AND organization_id = ${organizationId} AND deleted_at IS NULL
          FOR UPDATE
        `;
          const workspace = rows[0];
          if (workspace === undefined) return yield* fail("workspace_not_found");
          const generation = numberValue(workspace.generation);
          if (generation !== request.expectedGeneration) return yield* fail("stale_generation");
          if (workspace.desired_state === request.desiredState) {
            return { workspaceId, desiredState: request.desiredState, generation, changed: false };
          }
          if (request.desiredState === "Running") {
            const quotaRows = yield* sql<QuotaRow>`
            SELECT max_workspaces, max_running_workspaces, max_cpu_millis,
                   max_memory_bytes, max_storage_bytes
            FROM organization_quotas
            WHERE organization_id = ${organizationId}
            FOR UPDATE
          `;
            const quota = quotaRows[0];
            if (quota === undefined) return yield* fail("organization_quota_missing");
            const countRows = yield* sql<{ readonly count: string | number }>`
            SELECT count(*) AS count FROM workspaces
            WHERE organization_id = ${organizationId}
              AND desired_state = 'Running' AND deleted_at IS NULL
          `;
            if (numberValue(countRows[0]?.count) + 1 > numberValue(quota.max_running_workspaces)) {
              return yield* fail("running_workspace_quota_exceeded");
            }
          }
          const nextGeneration = generation + 1;
          yield* sql`
          UPDATE workspaces
          SET desired_state = ${request.desiredState}, generation = ${nextGeneration},
              phase = ${request.desiredState === "Running" ? "Starting" : "Stopping"},
              updated_at = now()
          WHERE id = ${workspaceId} AND organization_id = ${organizationId}
        `;
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, metadata
          ) VALUES (
            ${requestId}, ${actorPrincipalId}, ${organizationId},
            ${request.desiredState === "Running" ? "workspace.start" : "workspace.stop"},
            'workspace', ${workspaceId}, 'allowed',
            ${sql.json({ desiredState: request.desiredState, generation: nextGeneration })}
          )
        `;
          yield* sql`
          INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
          VALUES (
            'workspace', ${workspaceId}, 'workspace.desired-state.changed',
            ${sql.json({
              workspaceId,
              desiredState: request.desiredState,
              generation: nextGeneration,
            })}
          )
        `;
          return {
            workspaceId,
            desiredState: request.desiredState,
            generation: nextGeneration,
            changed: true,
          };
        }),
      )
      .pipe(mapPersistenceError);
  });

  const deleteWorkspace: WorkspaceRepository["Service"]["delete"] = Effect.fn(
    "WorkspaceRepository.delete",
  )(function* (workspaceId, organizationId, actorPrincipalId, requestId, request) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly generation: string | number;
            readonly volume_id: WorkspaceVolumeId;
            readonly kubernetes_pvc_name: string;
            readonly kubernetes_pvc_uid: string | null;
            readonly volume_source: "created" | "imported";
          }>`
          SELECT workspaces.generation, workspaces.volume_id,
                 volumes.kubernetes_pvc_name, volumes.kubernetes_pvc_uid,
                 volumes.source AS volume_source
          FROM workspaces
          JOIN workspace_volumes AS volumes ON volumes.id = workspaces.volume_id
          WHERE workspaces.id = ${workspaceId}
            AND workspaces.organization_id = ${organizationId}
            AND workspaces.deleted_at IS NULL
          FOR UPDATE OF workspaces, volumes
        `;
          const row = rows[0];
          if (row === undefined) return yield* fail("workspace_not_found");
          const generation = numberValue(row.generation);
          if (generation !== request.expectedGeneration) return yield* fail("stale_generation");
          if (request.volumePolicy === "delete" && row.volume_source === "imported") {
            return yield* fail("imported_volume_delete_forbidden");
          }
          const nextGeneration = generation + 1;
          yield* sql`
          UPDATE workspaces
          SET desired_state = 'Stopped', phase = 'Deleting', generation = ${nextGeneration},
              deleted_at = now(), updated_at = now()
          WHERE id = ${workspaceId}
        `;
          yield* sql`
          UPDATE workspace_volumes
          SET status = 'deleting', updated_at = now()
          WHERE id = ${row.volume_id}
        `;
          const target = {
            workspaceId,
            resourceName: `ws-${workspaceId}`,
            volumeId: row.volume_id,
            pvcName: row.kubernetes_pvc_name,
            ...(row.kubernetes_pvc_uid === null ? {} : { pvcUid: row.kubernetes_pvc_uid }),
            volumeSource: row.volume_source,
            volumePolicy: request.volumePolicy,
            generation: nextGeneration,
          };
          yield* sql`
          INSERT INTO audit_events (
            request_id, actor_principal_id, organization_id, action,
            resource_type, resource_id, result, metadata
          ) VALUES (
            ${requestId}, ${actorPrincipalId}, ${organizationId}, 'workspace.delete',
            'workspace', ${workspaceId}, 'allowed', ${sql.json(target)}
          )
        `;
          yield* sql`
          INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
          VALUES ('workspace', ${workspaceId}, 'workspace.deleted', ${sql.json(target)})
        `;
          return { workspaceId, generation: nextGeneration };
        }),
      )
      .pipe(mapPersistenceError);
  });

  return WorkspaceRepository.of({
    create,
    delete: deleteWorkspace,
    migrateImage,
    updateDesiredState,
  });
});

export const layer = Layer.effect(WorkspaceRepository, make);
