import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type OrganizationId,
  type WorkspaceId,
  type WorkspaceStorageSummary,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WorkspaceQueryError extends Schema.TaggedErrorClass<WorkspaceQueryError>()(
  "WorkspaceQueryError",
  {
    reason: Schema.Literals(["workspace_not_found", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface WorkspaceSummary {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly desiredState: "Running" | "Stopped";
  readonly phase: "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed" | "Deleting";
  readonly generation: number;
  readonly observedGeneration: number;
  readonly nodeName: string;
  readonly imageProfile: string;
  readonly imageRevision: string;
  readonly resources: {
    readonly cpuRequestMillis: number;
    readonly cpuLimitMillis: number;
    readonly memoryRequestBytes: number;
    readonly memoryLimitBytes: number;
    readonly ephemeralStorageBytes: number;
    readonly gpu?: { readonly className: string; readonly count: number };
  };
  readonly storage: WorkspaceStorageSummary;
  readonly egressProfile: string;
  readonly routeHost?: string;
  readonly environmentId?: string;
  readonly failureReason?: string;
  readonly failureMessage?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface WorkspaceRow {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly slug: string;
  readonly desired_state: WorkspaceSummary["desiredState"];
  readonly phase: WorkspaceSummary["phase"];
  readonly generation: string | number;
  readonly observed_generation: string | number;
  readonly node_name: string;
  readonly image_profile: string;
  readonly image_revision: string;
  readonly cpu_request_millis: string | number;
  readonly cpu_limit_millis: string | number;
  readonly memory_request_bytes: string | number;
  readonly memory_limit_bytes: string | number;
  readonly ephemeral_storage_bytes: string | number;
  readonly gpu_class: string | null;
  readonly gpu_count: string | number | null;
  readonly egress_profile: string;
  readonly storage_class: string;
  readonly capacity_bytes: string | number;
  readonly access_mode: "ReadWriteOnce" | "ReadWriteMany";
  readonly volume_source: "created" | "imported";
  readonly retention_policy: "retain" | "delete";
  readonly route_host: string | null;
  readonly environment_id: string | null;
  readonly failure_reason: string | null;
  readonly failure_message: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const mapRow = (row: WorkspaceRow): WorkspaceSummary => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  desiredState: row.desired_state,
  phase: row.phase,
  generation: Number(row.generation),
  observedGeneration: Number(row.observed_generation),
  nodeName: row.node_name,
  imageProfile: row.image_profile,
  imageRevision: row.image_revision,
  resources: {
    cpuRequestMillis: Number(row.cpu_request_millis),
    cpuLimitMillis: Number(row.cpu_limit_millis),
    memoryRequestBytes: Number(row.memory_request_bytes),
    memoryLimitBytes: Number(row.memory_limit_bytes),
    ephemeralStorageBytes: Number(row.ephemeral_storage_bytes),
    ...(row.gpu_class === null
      ? {}
      : { gpu: { className: row.gpu_class, count: Number(row.gpu_count) } }),
  },
  storage: {
    capacityBytes: Number(row.capacity_bytes),
    storageClass: row.storage_class,
    accessMode: row.access_mode,
    source: row.volume_source,
    retentionPolicy: row.retention_policy,
  },
  egressProfile: row.egress_profile,
  ...(row.route_host === null ? {} : { routeHost: row.route_host }),
  ...(row.environment_id === null ? {} : { environmentId: row.environment_id }),
  ...(row.failure_reason === null ? {} : { failureReason: row.failure_reason }),
  ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class WorkspaceQuery extends Context.Service<
  WorkspaceQuery,
  {
    readonly list: (
      organizationId: OrganizationId,
    ) => Effect.Effect<ReadonlyArray<WorkspaceSummary>, WorkspaceQueryError>;
    readonly get: (
      organizationId: OrganizationId,
      workspaceId: WorkspaceId,
    ) => Effect.Effect<WorkspaceSummary, WorkspaceQueryError>;
  }
>()("@t3tools/control-plane/WorkspaceQuery") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const select = (organizationId: OrganizationId, workspaceId?: WorkspaceId) =>
    sql<WorkspaceRow>`
      SELECT workspaces.id, workspaces.name, workspaces.slug, workspaces.desired_state,
             workspaces.phase, workspaces.generation, workspaces.observed_generation,
             workspaces.node_name, workspaces.image_profile, workspaces.image_revision,
             workspaces.cpu_request_millis, workspaces.cpu_limit_millis,
             workspaces.memory_request_bytes, workspaces.memory_limit_bytes,
             workspaces.ephemeral_storage_bytes, workspaces.gpu_class, workspaces.gpu_count,
             workspaces.egress_profile, volumes.storage_class, volumes.capacity_bytes, volumes.access_mode,
             volumes.source AS volume_source, volumes.retention_policy,
             workspaces.route_host, workspaces.environment_id, workspaces.failure_reason,
             workspaces.failure_message, workspaces.created_at, workspaces.updated_at
      FROM workspaces
      JOIN workspace_volumes AS volumes ON volumes.id = workspaces.volume_id
      WHERE workspaces.organization_id = ${organizationId} AND workspaces.deleted_at IS NULL
        AND (${workspaceId ?? null}::uuid IS NULL OR workspaces.id = ${workspaceId ?? null})
      ORDER BY workspaces.created_at DESC, workspaces.id
    `.pipe(
      Effect.mapError((cause) => new WorkspaceQueryError({ reason: "persistence_failed", cause })),
    );
  const list: WorkspaceQuery["Service"]["list"] = Effect.fn("WorkspaceQuery.list")(
    function* (organizationId) {
      return (yield* select(organizationId)).map(mapRow);
    },
  );
  const get: WorkspaceQuery["Service"]["get"] = Effect.fn("WorkspaceQuery.get")(
    function* (organizationId, workspaceId) {
      const row = (yield* select(organizationId, workspaceId))[0];
      if (row === undefined)
        return yield* new WorkspaceQueryError({ reason: "workspace_not_found" });
      return mapRow(row);
    },
  );
  return WorkspaceQuery.of({ list, get });
});

export const layer = Layer.effect(WorkspaceQuery, make);
