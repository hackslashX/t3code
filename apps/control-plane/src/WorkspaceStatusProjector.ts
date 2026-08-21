import { OrganizationId, WorkspaceId } from "@t3tools/hosted-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as WorkspaceStatusRepository from "./WorkspaceStatusRepository.ts";

const ProjectableConditionType = Schema.Literals([
  "StorageReady",
  "Scheduled",
  "PodReady",
  "RouteReady",
  "Authenticated",
]);

const WorkspaceStatusResource = Schema.Struct({
  metadata: Schema.Struct({
    generation: Schema.optionalKey(Schema.Int),
  }),
  spec: Schema.Struct({
    workspaceId: WorkspaceId,
    organizationId: OrganizationId,
    workspaceGeneration: Schema.Int,
    routeHost: Schema.optionalKey(Schema.String),
  }),
  status: Schema.optionalKey(
    Schema.Struct({
      observedWorkspaceGeneration: Schema.optionalKey(Schema.Int),
      phase: Schema.optionalKey(
        Schema.Literals(["Starting", "Ready", "Stopping", "Stopped", "Failed", "Deleting"]),
      ),
      environmentId: Schema.optionalKey(Schema.String),
      conditions: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            type: Schema.String,
            status: Schema.Literals(["True", "False", "Unknown"]),
            reason: Schema.String,
            message: Schema.String,
            observedGeneration: Schema.optionalKey(Schema.Int),
            lastTransitionTime: Schema.DateTimeUtcFromString,
          }),
        ),
      ),
    }),
  ),
});

export const projectWorkspaceStatus = Effect.fn("WorkspaceStatusProjector.project")(function* (
  resource: unknown,
) {
  const decoded = yield* Schema.decodeUnknownEffect(WorkspaceStatusResource)(resource);
  const status = decoded.status;
  if (
    status?.phase === undefined ||
    status.observedWorkspaceGeneration === undefined ||
    status.observedWorkspaceGeneration !== decoded.spec.workspaceGeneration
  ) {
    return false;
  }
  const observedWorkspaceGeneration = status.observedWorkspaceGeneration;
  const repository = yield* WorkspaceStatusRepository.WorkspaceStatusRepository;
  yield* repository.project({
    workspaceId: decoded.spec.workspaceId,
    organizationId: decoded.spec.organizationId,
    observedWorkspaceGeneration,
    phase: status.phase,
    ...(status.environmentId === undefined ? {} : { environmentId: status.environmentId }),
    ...(decoded.spec.routeHost === undefined ? {} : { routeHost: decoded.spec.routeHost }),
    conditions: (status.conditions ?? []).flatMap((condition) => {
      if (!Schema.is(ProjectableConditionType)(condition.type)) return [];
      return [
        {
          type: condition.type,
          status: condition.status,
          reason: condition.reason,
          message: condition.message,
          observedGeneration: observedWorkspaceGeneration,
          lastTransitionAt: DateTime.toDate(condition.lastTransitionTime),
        },
      ];
    }),
  });
  return true;
});
