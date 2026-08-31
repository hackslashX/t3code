import * as PgClient from "@effect/sql-pg/PgClient";
import {
  type ExistingVolumeOption,
  type OrganizationId,
  type StorageClassOption,
  type WorkspaceImageProfileOption,
} from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as WorkspaceCatalog from "./WorkspaceCatalog.ts";

export class StorageQueryError extends Schema.TaggedErrorClass<StorageQueryError>()(
  "StorageQueryError",
  {
    reason: Schema.Literal("persistence_failed"),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface StorageOptions {
  readonly nodes: ReadonlyArray<string>;
  readonly imageProfiles: ReadonlyArray<WorkspaceImageProfileOption>;
  readonly storageClasses: ReadonlyArray<StorageClassOption>;
  readonly existingVolumes: ReadonlyArray<ExistingVolumeOption>;
}

export class StorageQuery extends Context.Service<
  StorageQuery,
  {
    readonly listOptions: (
      organizationId: OrganizationId,
    ) => Effect.Effect<StorageOptions, StorageQueryError>;
  }
>()("@t3tools/control-plane/StorageQuery") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const catalog = yield* WorkspaceCatalog.WorkspaceCatalog;
  const listOptions: StorageQuery["Service"]["listOptions"] = Effect.fn("StorageQuery.listOptions")(
    function* (organizationId) {
      const rows = yield* sql<{
        readonly id: ExistingVolumeOption["id"];
        readonly storage_class: string;
        readonly capacity_bytes: string | number;
        readonly access_mode: ExistingVolumeOption["accessMode"];
        readonly status: ExistingVolumeOption["status"];
      }>`
      SELECT id, storage_class, capacity_bytes, access_mode, status
      FROM workspace_volumes
      WHERE organization_id = ${organizationId} AND status IN ('available', 'attached')
      ORDER BY created_at DESC, id
    `.pipe(
        Effect.mapError((cause) => new StorageQueryError({ reason: "persistence_failed", cause })),
      );
      return {
        nodes: [...catalog.nodes],
        imageProfiles: [...catalog.imageProfiles.values()].map(({ id, revision }) => ({
          id,
          revision,
        })),
        storageClasses: [...catalog.storageClasses.values()],
        existingVolumes: rows.map((row) => ({
          id: row.id,
          organizationId,
          storageClass: row.storage_class,
          capacityBytes: Number(row.capacity_bytes),
          accessMode: row.access_mode,
          status: row.status,
        })),
      };
    },
  );
  return StorageQuery.of({ listOptions });
});

export const layer = Layer.effect(StorageQuery, make);
