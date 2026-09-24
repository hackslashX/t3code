import * as PgClient from "@effect/sql-pg/PgClient";
import { OrganizationId, WorkspaceId } from "@t3tools/hosted-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const ConditionType = Schema.Literals([
  "StorageReady",
  "Scheduled",
  "PodReady",
  "RouteReady",
  "Authenticated",
]);
type ConditionType = typeof ConditionType.Type;

export interface WorkspaceStatusProjection {
  readonly workspaceId: WorkspaceId;
  readonly organizationId: OrganizationId;
  readonly observedWorkspaceGeneration: number;
  readonly phase: "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed" | "Deleting";
  readonly environmentId?: string;
  readonly routeHost?: string;
  readonly conditions: ReadonlyArray<{
    readonly type: ConditionType;
    readonly status: "True" | "False" | "Unknown";
    readonly reason: string;
    readonly message: string;
    readonly observedGeneration: number;
    readonly lastTransitionAt: Date;
  }>;
}

export class WorkspaceStatusRepositoryError extends Schema.TaggedErrorClass<WorkspaceStatusRepositoryError>()(
  "WorkspaceStatusRepositoryError",
  {
    reason: Schema.Literals(["workspace_not_found", "invalid_generation", "persistence_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WorkspaceStatusRepository extends Context.Service<
  WorkspaceStatusRepository,
  {
    readonly project: (
      input: WorkspaceStatusProjection,
    ) => Effect.Effect<void, WorkspaceStatusRepositoryError>;
  }
>()("@t3tools/control-plane/WorkspaceStatusRepository") {}

export const make = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const project: WorkspaceStatusRepository["Service"]["project"] = Effect.fn(
    "WorkspaceStatusRepository.project",
  )(function* (input) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{
            readonly generation: string | number;
            readonly observed_generation: string | number;
            readonly volume_id: string;
          }>`
          SELECT generation, observed_generation, volume_id
          FROM workspaces
          WHERE id = ${input.workspaceId} AND organization_id = ${input.organizationId}
            AND deleted_at IS NULL
          FOR UPDATE
        `;
          const workspace = rows[0];
          if (workspace === undefined) {
            return yield* new WorkspaceStatusRepositoryError({ reason: "workspace_not_found" });
          }
          const generation = Number(workspace.generation);
          const currentObservedGeneration = Number(workspace.observed_generation);
          if (input.observedWorkspaceGeneration > generation) {
            return yield* new WorkspaceStatusRepositoryError({ reason: "invalid_generation" });
          }
          if (input.observedWorkspaceGeneration < currentObservedGeneration) return;
          yield* sql`
          UPDATE workspaces
          SET observed_generation = ${input.observedWorkspaceGeneration},
              phase = ${input.phase},
              environment_id = coalesce(${input.environmentId ?? null}, environment_id),
              route_host = coalesce(${input.routeHost ?? null}, route_host),
              failure_reason = ${input.phase === "Failed" ? (input.conditions.find((item) => item.status === "False")?.reason ?? "WorkspaceFailed") : null},
              failure_message = ${input.phase === "Failed" ? (input.conditions.find((item) => item.status === "False")?.message ?? "Workspace reconciliation failed.") : null},
              updated_at = now()
          WHERE id = ${input.workspaceId} AND organization_id = ${input.organizationId}
        `;
          for (const condition of input.conditions) {
            yield* sql`
            INSERT INTO workspace_conditions (
              workspace_id, type, status, reason, message,
              observed_generation, last_transition_at
            ) VALUES (
              ${input.workspaceId}, ${condition.type}, ${condition.status},
              ${condition.reason}, ${condition.message}, ${condition.observedGeneration},
              ${condition.lastTransitionAt}
            )
            ON CONFLICT (workspace_id, type) DO UPDATE SET
              status = excluded.status,
              reason = excluded.reason,
              message = excluded.message,
              observed_generation = excluded.observed_generation,
              last_transition_at = excluded.last_transition_at
            WHERE workspace_conditions.observed_generation <= excluded.observed_generation
          `;
          }
          const storage = input.conditions.find((item) => item.type === "StorageReady");
          if (storage?.status === "True") {
            yield* sql`
            UPDATE workspace_volumes
            SET status = 'attached', updated_at = now()
            WHERE id = ${workspace.volume_id} AND attached_workspace_id = ${input.workspaceId}
              AND status IN ('provisioning', 'available', 'attached')
          `;
          } else if (storage?.reason === "VolumeLost") {
            yield* sql`
            UPDATE workspace_volumes SET status = 'failed', updated_at = now()
            WHERE id = ${workspace.volume_id} AND attached_workspace_id = ${input.workspaceId}
          `;
          }
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          Schema.is(WorkspaceStatusRepositoryError)(cause)
            ? cause
            : new WorkspaceStatusRepositoryError({ reason: "persistence_failed", cause }),
        ),
      );
  });
  return WorkspaceStatusRepository.of({ project });
});

export const layer = Layer.effect(WorkspaceStatusRepository, make);
