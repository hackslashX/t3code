import * as PgClient from "@effect/sql-pg/PgClient";
import { type WorkspaceId } from "@t3tools/hosted-contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { T3WorkspaceResource } from "./operator/WorkspaceRenderer.ts";
import * as WorkspaceCatalog from "./WorkspaceCatalog.ts";

export class WorkspaceProjectionError extends Schema.TaggedErrorClass<WorkspaceProjectionError>()(
  "WorkspaceProjectionError",
  {
    reason: Schema.Literals(["workspace_not_found", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WorkspaceProjectionConfig extends Context.Service<
  WorkspaceProjectionConfig,
  {
    readonly namespace: string;
    // Kept optional for compatibility with older focused test layers. Images now come from catalog.json.
    readonly t3Image?: string;
    readonly codeServerImage?: string;
    readonly hostedAuthIssuer: string;
    readonly hostedAuthPublicKeysConfigMap: string;
  }
>()("@t3tools/control-plane/WorkspaceProjection/WorkspaceProjectionConfig") {}

const config = Config.all({
  namespace: Config.string("T3CODE_WORKSPACE_NAMESPACE"),
  hostedAuthIssuer: Config.string("T3CODE_HOSTED_WORKSPACE_ISSUER"),
  hostedAuthPublicKeysConfigMap: Config.string("T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_CONFIG_MAP"),
});

export const configLayer = Layer.effect(
  WorkspaceProjectionConfig,
  Effect.map(config, WorkspaceProjectionConfig.of),
);

interface ProjectionRow {
  readonly id: WorkspaceId;
  readonly organization_id: string;
  readonly desired_state: "Running" | "Stopped";
  readonly generation: string | number;
  readonly node_name: string;
  readonly environment_id: string;
  readonly image_profile: string;
  readonly egress_profile: string;
  readonly cpu_request_millis: string | number;
  readonly cpu_limit_millis: string | number;
  readonly memory_request_bytes: string | number;
  readonly memory_limit_bytes: string | number;
  readonly ephemeral_storage_bytes: string | number;
  readonly gpu_class: string | null;
  readonly gpu_count: number | null;
  readonly route_host: string | null;
  readonly volume_id: string;
  readonly kubernetes_pvc_name: string;
  readonly storage_class: string;
  readonly capacity_bytes: string | number;
  readonly access_mode: "ReadWriteOnce" | "ReadWriteMany";
  readonly volume_source: "created" | "imported";
  readonly retention_policy: "retain" | "delete";
}

export interface WorkspaceProjectionResult {
  readonly volumeId: string;
  readonly resource: T3WorkspaceResource;
  readonly persistentVolumeClaim?: {
    readonly apiVersion: "v1";
    readonly kind: "PersistentVolumeClaim";
    readonly metadata: {
      readonly name: string;
      readonly namespace: string;
      readonly labels: Readonly<Record<string, string>>;
    };
    readonly spec: {
      readonly accessModes: ReadonlyArray<"ReadWriteOnce" | "ReadWriteMany">;
      readonly storageClassName: string;
      readonly volumeMode: "Filesystem";
      readonly resources: { readonly requests: { readonly storage: string } };
    };
  };
}

export class WorkspaceProjection extends Context.Service<
  WorkspaceProjection,
  {
    readonly getResource: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<WorkspaceProjectionResult, WorkspaceProjectionError>;
  }
>()("@t3tools/control-plane/WorkspaceProjection") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const projectionConfig = yield* WorkspaceProjectionConfig;
  const catalog = yield* WorkspaceCatalog.WorkspaceCatalog;
  const getResource: WorkspaceProjection["Service"]["getResource"] = Effect.fn(
    "WorkspaceProjection.getResource",
  )(function* (workspaceId) {
    const rows = yield* sql<ProjectionRow>`
      SELECT workspaces.id, workspaces.organization_id, workspaces.desired_state,
             workspaces.generation, workspaces.node_name, workspaces.environment_id,
             workspaces.image_profile, workspaces.egress_profile,
             workspaces.cpu_request_millis, workspaces.cpu_limit_millis,
             workspaces.memory_request_bytes, workspaces.memory_limit_bytes,
             workspaces.ephemeral_storage_bytes, workspaces.gpu_class,
             workspaces.gpu_count, workspaces.route_host,
             volumes.id AS volume_id, volumes.kubernetes_pvc_name,
             volumes.storage_class, volumes.capacity_bytes, volumes.access_mode,
             volumes.source AS volume_source, volumes.retention_policy
      FROM workspaces
      JOIN workspace_volumes AS volumes ON volumes.id = workspaces.volume_id
      WHERE workspaces.id = ${workspaceId} AND workspaces.deleted_at IS NULL
    `.pipe(
      Effect.mapError(
        (cause) => new WorkspaceProjectionError({ reason: "persistence_failed", cause }),
      ),
    );
    const row = rows[0];
    if (row === undefined) {
      return yield* new WorkspaceProjectionError({ reason: "workspace_not_found" });
    }
    const profile = catalog.imageProfiles.get(row.image_profile);
    if (profile === undefined) {
      return yield* new WorkspaceProjectionError({ reason: "workspace_not_found" });
    }
    const resource: T3WorkspaceResource = {
      metadata: {
        name: `ws-${row.id}`,
        namespace: projectionConfig.namespace,
      },
      spec: {
        organizationId: row.organization_id,
        workspaceId: row.id,
        desiredState: row.desired_state,
        workspaceGeneration: Number(row.generation),
        pvcName: row.kubernetes_pvc_name,
        nodeName: row.node_name,
        environmentId: row.environment_id,
        imageProfile: profile.id,
        imageRevision: profile.revision,
        egressProfile: row.egress_profile,
        t3Image: profile.t3Image,
        codeServerImage: profile.codeServerImage,
        hostedAuth: {
          issuer: projectionConfig.hostedAuthIssuer,
          publicKeysConfigMap: projectionConfig.hostedAuthPublicKeysConfigMap,
        },
        ...(row.route_host === null ? {} : { routeHost: row.route_host }),
        resources: {
          cpuRequest: `${row.cpu_request_millis}m`,
          cpuLimit: `${row.cpu_limit_millis}m`,
          memoryRequest: String(row.memory_request_bytes),
          memoryLimit: String(row.memory_limit_bytes),
          ephemeralStorage: String(row.ephemeral_storage_bytes),
        },
        ...(row.gpu_class === null ? {} : { gpuClass: row.gpu_class }),
        ...(row.gpu_count === null ? {} : { gpuCount: row.gpu_count }),
      },
    };
    return {
      volumeId: row.volume_id,
      resource,
      ...(row.volume_source === "imported"
        ? {}
        : {
            persistentVolumeClaim: {
              apiVersion: "v1" as const,
              kind: "PersistentVolumeClaim" as const,
              metadata: {
                name: row.kubernetes_pvc_name,
                namespace: projectionConfig.namespace,
                labels: {
                  "app.kubernetes.io/name": "t3-workspace-volume",
                  "hosted.t3.codes/organization-id": row.organization_id,
                  "hosted.t3.codes/volume-id": row.volume_id,
                  "hosted.t3.codes/retention-policy": row.retention_policy,
                },
              },
              spec: {
                accessModes: [row.access_mode],
                storageClassName: row.storage_class,
                volumeMode: "Filesystem" as const,
                resources: { requests: { storage: String(row.capacity_bytes) } },
              },
            },
          }),
    };
  });
  return WorkspaceProjection.of({ getResource });
});

export const layer = Layer.effect(WorkspaceProjection, make);
