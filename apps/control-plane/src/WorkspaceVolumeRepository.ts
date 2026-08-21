import * as PgClient from "@effect/sql-pg/PgClient";
import { WorkspaceVolumeId } from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class WorkspaceVolumeRepositoryError extends Schema.TaggedErrorClass<WorkspaceVolumeRepositoryError>()(
  "WorkspaceVolumeRepositoryError",
  {
    reason: Schema.Literals(["volume_not_found", "pvc_uid_conflict", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WorkspaceVolumeRepository extends Context.Service<
  WorkspaceVolumeRepository,
  {
    readonly finalizeDeletion: (
      volumeId: WorkspaceVolumeId,
      policy: "retain" | "delete",
    ) => Effect.Effect<void, WorkspaceVolumeRepositoryError>;
    readonly recordPvcUid: (
      volumeId: WorkspaceVolumeId,
      pvcUid: string,
    ) => Effect.Effect<void, WorkspaceVolumeRepositoryError>;
  }
>()("@t3tools/control-plane/WorkspaceVolumeRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const recordPvcUid: WorkspaceVolumeRepository["Service"]["recordPvcUid"] = Effect.fn(
    "WorkspaceVolumeRepository.recordPvcUid",
  )(function* (volumeId, pvcUid) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ readonly kubernetes_pvc_uid: string | null }>`
          SELECT kubernetes_pvc_uid FROM workspace_volumes WHERE id = ${volumeId} FOR UPDATE
        `;
          const volume = rows[0];
          if (volume === undefined) {
            return yield* new WorkspaceVolumeRepositoryError({ reason: "volume_not_found" });
          }
          if (volume.kubernetes_pvc_uid !== null && volume.kubernetes_pvc_uid !== pvcUid) {
            return yield* new WorkspaceVolumeRepositoryError({ reason: "pvc_uid_conflict" });
          }
          if (volume.kubernetes_pvc_uid === null) {
            yield* sql`
            UPDATE workspace_volumes SET kubernetes_pvc_uid = ${pvcUid}, updated_at = now()
            WHERE id = ${volumeId}
          `;
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(WorkspaceVolumeRepositoryError)(cause)
            ? cause
            : new WorkspaceVolumeRepositoryError({ reason: "persistence_failed", cause }),
        ),
      );
  });
  const finalizeDeletion: WorkspaceVolumeRepository["Service"]["finalizeDeletion"] = Effect.fn(
    "WorkspaceVolumeRepository.finalizeDeletion",
  )(function* (volumeId, policy) {
    const rows = yield* sql<{ readonly id: string }>`
      UPDATE workspace_volumes
      SET attached_workspace_id = NULL,
          status = ${policy === "retain" ? "available" : "deleting"},
          updated_at = now()
      WHERE id = ${volumeId} AND status = 'deleting'
      RETURNING id
    `.pipe(
      Effect.mapError(
        (cause) => new WorkspaceVolumeRepositoryError({ reason: "persistence_failed", cause }),
      ),
    );
    if (rows[0] === undefined) {
      return yield* new WorkspaceVolumeRepositoryError({ reason: "volume_not_found" });
    }
  });
  return WorkspaceVolumeRepository.of({ finalizeDeletion, recordPvcUid });
});

export const layer = Layer.effect(WorkspaceVolumeRepository, make);
