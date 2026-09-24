import { WorkspaceId, WorkspaceVolumeId } from "@t3tools/hosted-contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as OutboxRepository from "./OutboxRepository.ts";
import { WorkspaceDeletionTarget } from "./WorkspaceDeletion.ts";
import * as WorkspaceProjection from "./WorkspaceProjection.ts";
import * as WorkspaceResourcePublisher from "./WorkspaceResourcePublisher.ts";
import * as WorkspaceVolumeRepository from "./WorkspaceVolumeRepository.ts";

const errorCode = (value: unknown, depth = 0): string | undefined => {
  if (depth > 3 || typeof value !== "object" || value === null) return undefined;
  if ("code" in value && typeof value.code === "string") return value.code;
  return "cause" in value ? errorCode(value.cause, depth + 1) : undefined;
};

export const dispatchNextOutboxEvent = Effect.fn("OutboxDispatcher.dispatchNext")(function* (
  workerId: string,
) {
  const repository = yield* OutboxRepository.OutboxRepository;
  const claimed = yield* repository.claimNext(workerId);
  if (Option.isNone(claimed)) return false;
  const event = claimed.value;
  if (event.aggregateType !== "workspace") {
    yield* repository.complete(workerId, event.id);
    return true;
  }
  const projection = yield* WorkspaceProjection.WorkspaceProjection;
  const publisher = yield* WorkspaceResourcePublisher.WorkspaceResourcePublisher;
  const volumes = yield* WorkspaceVolumeRepository.WorkspaceVolumeRepository;
  const published = yield* Effect.gen(function* () {
    if (event.eventType === "workspace.deleted") {
      const target = yield* Schema.decodeUnknownEffect(WorkspaceDeletionTarget)(event.payload);
      const namespace = (yield* WorkspaceProjection.WorkspaceProjectionConfig).namespace;
      const removed = yield* publisher.remove(target, namespace);
      if (!removed.complete) return false;
      yield* volumes.finalizeDeletion(WorkspaceVolumeId.make(target.volumeId), target.volumePolicy);
      return true;
    }
    const desired = yield* projection.getResource(WorkspaceId.make(event.aggregateId));
    const result = yield* publisher.apply(desired);
    if (result.pvcUid !== undefined) {
      yield* volumes.recordPvcUid(WorkspaceVolumeId.make(desired.volumeId), result.pvcUid);
    }
    return true;
  }).pipe(Effect.exit);
  if (published._tag === "Failure") {
    const failure = Cause.squash(published.cause);
    const reason =
      typeof failure === "object" && failure !== null && "reason" in failure
        ? String(failure.reason)
        : "workspace_projection_failed";
    const operation =
      typeof failure === "object" && failure !== null && "operation" in failure
        ? String(failure.operation)
        : undefined;
    const code = errorCode(failure);
    yield* Effect.logWarning("Workspace publication failed", {
      workspaceId: event.aggregateId,
      reason,
      ...(operation === undefined ? {} : { operation }),
      ...(code === undefined ? {} : { code }),
    });
    yield* repository.fail(workerId, event.id, reason);
    return false;
  }
  if (!published.value) {
    yield* repository.fail(workerId, event.id, "workspace_cleanup_pending");
    return false;
  }
  yield* repository.complete(workerId, event.id);
  return true;
});
