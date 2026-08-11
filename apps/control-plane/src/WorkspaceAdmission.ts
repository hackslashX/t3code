import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type ExistingVolumeOption,
  type OrganizationId,
  type OrganizationQuota,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceCatalog from "./WorkspaceCatalog.ts";
import type { WorkspaceAdmissionPolicy } from "./workspacePolicy.ts";

export class WorkspaceAdmissionError extends Schema.TaggedErrorClass<WorkspaceAdmissionError>()(
  "WorkspaceAdmissionError",
  {
    reason: Schema.Literals(["organization_quota_missing", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WorkspaceAdmission extends Context.Service<
  WorkspaceAdmission,
  {
    readonly load: (
      organizationId: OrganizationId,
    ) => Effect.Effect<WorkspaceAdmissionPolicy, WorkspaceAdmissionError>;
  }
>()("@t3tools/control-plane/WorkspaceAdmission") {}

const numberValue = (value: string | number | undefined) => Number(value ?? 0);

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const catalog = yield* WorkspaceCatalog.WorkspaceCatalog;
  const load: WorkspaceAdmission["Service"]["load"] = Effect.fn("WorkspaceAdmission.load")(
    function* (organizationId) {
      const quotaRows = yield* sql<{
        readonly max_workspaces: number;
        readonly max_running_workspaces: number;
        readonly max_cpu_millis: string | number;
        readonly max_memory_bytes: string | number;
        readonly max_storage_bytes: string | number;
        readonly max_gpu_by_class: Record<string, number>;
      }>`
        SELECT max_workspaces, max_running_workspaces, max_cpu_millis,
               max_memory_bytes, max_storage_bytes, max_gpu_by_class
        FROM organization_quotas WHERE organization_id = ${organizationId}
      `.pipe(
        Effect.mapError(
          (cause) => new WorkspaceAdmissionError({ reason: "persistence_failed", cause }),
        ),
      );
      const row = quotaRows[0];
      if (row === undefined) {
        return yield* new WorkspaceAdmissionError({ reason: "organization_quota_missing" });
      }
      const usageRows = yield* sql<{
        readonly workspace_count: string | number;
        readonly running_workspace_count: string | number;
        readonly cpu_millis: string | number;
        readonly memory_bytes: string | number;
        readonly storage_bytes: string | number;
      }>`
        SELECT
          (SELECT count(*) FROM workspaces WHERE organization_id = ${organizationId} AND deleted_at IS NULL) AS workspace_count,
          (SELECT count(*) FROM workspaces WHERE organization_id = ${organizationId} AND deleted_at IS NULL AND desired_state = 'Running') AS running_workspace_count,
          (SELECT coalesce(sum(cpu_limit_millis), 0) FROM workspaces WHERE organization_id = ${organizationId} AND deleted_at IS NULL) AS cpu_millis,
          (SELECT coalesce(sum(memory_limit_bytes), 0) FROM workspaces WHERE organization_id = ${organizationId} AND deleted_at IS NULL) AS memory_bytes,
          (SELECT coalesce(sum(capacity_bytes), 0) FROM workspace_volumes WHERE organization_id = ${organizationId} AND status <> 'deleting') AS storage_bytes
      `.pipe(
        Effect.mapError(
          (cause) => new WorkspaceAdmissionError({ reason: "persistence_failed", cause }),
        ),
      );
      const gpuRows = yield* sql<{
        readonly gpu_class: string;
        readonly count: string | number;
      }>`
        SELECT gpu_class, coalesce(sum(gpu_count), 0) AS count
        FROM workspaces
        WHERE organization_id = ${organizationId} AND deleted_at IS NULL AND gpu_class IS NOT NULL
        GROUP BY gpu_class
      `.pipe(
        Effect.mapError(
          (cause) => new WorkspaceAdmissionError({ reason: "persistence_failed", cause }),
        ),
      );
      const volumeRows = yield* sql<{
        readonly id: ExistingVolumeOption["id"];
        readonly storage_class: string;
        readonly capacity_bytes: string | number;
        readonly access_mode: ExistingVolumeOption["accessMode"];
        readonly status: "available" | "attached";
      }>`
        SELECT id, storage_class, capacity_bytes, access_mode, status
        FROM workspace_volumes
        WHERE organization_id = ${organizationId} AND status IN ('available', 'attached')
      `.pipe(
        Effect.mapError(
          (cause) => new WorkspaceAdmissionError({ reason: "persistence_failed", cause }),
        ),
      );
      const quota: OrganizationQuota = {
        organizationId,
        maxWorkspaces: row.max_workspaces,
        maxRunningWorkspaces: row.max_running_workspaces,
        maxCpuMillis: numberValue(row.max_cpu_millis),
        maxMemoryBytes: numberValue(row.max_memory_bytes),
        maxStorageBytes: numberValue(row.max_storage_bytes),
        maxGpuByClass: row.max_gpu_by_class,
      };
      const usage = usageRows[0];
      return {
        organizationId,
        quota,
        usage: {
          workspaceCount: numberValue(usage?.workspace_count),
          runningWorkspaceCount: numberValue(usage?.running_workspace_count),
          cpuMillis: numberValue(usage?.cpu_millis),
          memoryBytes: numberValue(usage?.memory_bytes),
          storageBytes: numberValue(usage?.storage_bytes),
          gpuByClass: new Map(gpuRows.map((gpu) => [gpu.gpu_class, numberValue(gpu.count)])),
        },
        imageProfiles: catalog.imageProfiles,
        egressProfiles: catalog.egressProfiles,
        nodes: catalog.nodes,
        storageClasses: catalog.storageClasses,
        existingVolumes: new Map(
          volumeRows.map((volume) => [
            volume.id,
            {
              id: volume.id,
              organizationId,
              storageClass: volume.storage_class,
              capacityBytes: numberValue(volume.capacity_bytes),
              accessMode: volume.access_mode,
              status: volume.status,
            },
          ]),
        ),
        gpuClassMaximums: catalog.gpuClassMaximums,
      };
    },
  );
  return WorkspaceAdmission.of({ load });
});

export const layer = Layer.effect(WorkspaceAdmission, make);
