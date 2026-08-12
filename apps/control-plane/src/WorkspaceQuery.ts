import * as PgClient from "@effect/sql-pg/PgClient";
import { type OrganizationId, type WorkspaceId } from "@t3tools/hosted-contracts";
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
      SELECT id, name, slug, desired_state, phase, generation, observed_generation,
             node_name, image_profile, image_revision, route_host, environment_id, failure_reason, failure_message,
             created_at, updated_at
      FROM workspaces
      WHERE organization_id = ${organizationId} AND deleted_at IS NULL
        AND (${workspaceId ?? null}::uuid IS NULL OR id = ${workspaceId ?? null})
      ORDER BY created_at DESC, id
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
