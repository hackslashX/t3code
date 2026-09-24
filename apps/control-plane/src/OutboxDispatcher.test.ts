import { assert, it } from "@effect/vitest";
import { WorkspaceId } from "@t3tools/hosted-contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { dispatchNextOutboxEvent } from "./OutboxDispatcher.ts";
import { OutboxRepository } from "./OutboxRepository.ts";
import { WorkspaceProjection, WorkspaceProjectionConfig } from "./WorkspaceProjection.ts";
import {
  WorkspaceResourcePublisher,
  WorkspaceResourcePublisherError,
} from "./WorkspaceResourcePublisher.ts";
import { WorkspaceVolumeRepository } from "./WorkspaceVolumeRepository.ts";

const workspaceId = WorkspaceId.make("00000000-0000-0000-0000-000000000020");
const projectionConfigLayer = Layer.succeed(
  WorkspaceProjectionConfig,
  WorkspaceProjectionConfig.of({
    namespace: "hosted",
    t3Image: "t3",
    codeServerImage: "code-server",
    hostedAuthIssuer: "https://hosted.example",
    hostedAuthPublicKeysConfigMap: "keys",
  }),
);

const resource = {
  metadata: { name: `ws-${workspaceId}`, namespace: "hosted" },
  spec: {
    organizationId: "00000000-0000-0000-0000-000000000010",
    workspaceId,
    desiredState: "Stopped" as const,
    workspaceGeneration: 0,
    pvcName: "workspace-pvc",
    nodeName: "orion",
    environmentId: "00000000-0000-4000-8000-000000000001",
    imageProfile: "stable",
    egressProfile: "restricted",
    t3Image: "t3@sha256:a",
    codeServerImage: "code@sha256:b",
    hostedAuth: { issuer: "https://hosted.example", publicKeysConfigMap: "keys" },
    resources: {
      cpuRequest: "500m",
      cpuLimit: "2000m",
      memoryRequest: "1073741824",
      memoryLimit: "4294967296",
      ephemeralStorage: "2147483648",
    },
  },
};

it.effect("publishes and completes a claimed workspace event", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (value: string) => Ref.update(calls, (items) => [...items, value]);
    const services = Layer.mergeAll(
      projectionConfigLayer,
      Layer.succeed(
        OutboxRepository,
        OutboxRepository.of({
          claimNext: () =>
            Effect.succeed(
              Option.some({
                id: "1",
                aggregateType: "workspace",
                aggregateId: workspaceId,
                eventType: "workspace.created",
                payload: {},
                attemptCount: 1,
              }),
            ),
          complete: () => record("complete"),
          fail: () => record("fail"),
        }),
      ),
      Layer.succeed(
        WorkspaceProjection,
        WorkspaceProjection.of({
          getResource: () => Effect.succeed({ volumeId: "volume-1", resource }),
        }),
      ),
      Layer.succeed(
        WorkspaceResourcePublisher,
        WorkspaceResourcePublisher.of({
          apply: () => record("apply").pipe(Effect.as({ pvcUid: "pvc-uid-1" })),
          remove: () => Effect.succeed({ complete: true }),
        }),
      ),
      Layer.succeed(
        WorkspaceVolumeRepository,
        WorkspaceVolumeRepository.of({
          finalizeDeletion: () => Effect.void,
          recordPvcUid: () => record("volume"),
        }),
      ),
    );
    assert.isTrue(yield* dispatchNextOutboxEvent("worker-1").pipe(Effect.provide(services)));
    assert.deepEqual(yield* Ref.get(calls), ["apply", "volume", "complete"]);
  }),
);

it.effect("finalizes retained storage after workspace resource deletion", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (value: string) => Ref.update(calls, (items) => [...items, value]);
    const deletedWorkspaceId = WorkspaceId.make("00000000-0000-4000-8000-000000000020");
    const services = Layer.mergeAll(
      projectionConfigLayer,
      Layer.succeed(
        OutboxRepository,
        OutboxRepository.of({
          claimNext: () =>
            Effect.succeed(
              Option.some({
                id: "2",
                aggregateType: "workspace",
                aggregateId: deletedWorkspaceId,
                eventType: "workspace.deleted",
                payload: {
                  workspaceId: deletedWorkspaceId,
                  resourceName: `ws-${deletedWorkspaceId}`,
                  volumeId: "00000000-0000-4000-8000-000000000030",
                  pvcName: "workspace-pvc",
                  nodeName: "orion",
                  environmentId: "00000000-0000-4000-8000-000000000001",
                  pvcUid: "pvc-uid-1",
                  volumeSource: "created",
                  volumePolicy: "retain",
                  generation: 1,
                },
                attemptCount: 1,
              }),
            ),
          complete: () => record("complete"),
          fail: () => record("fail"),
        }),
      ),
      Layer.succeed(
        WorkspaceProjection,
        WorkspaceProjection.of({ getResource: () => Effect.die("unexpected projection") }),
      ),
      Layer.succeed(
        WorkspaceResourcePublisher,
        WorkspaceResourcePublisher.of({
          apply: () => Effect.die("unexpected apply"),
          remove: () => record("remove").pipe(Effect.as({ complete: true })),
        }),
      ),
      Layer.succeed(
        WorkspaceVolumeRepository,
        WorkspaceVolumeRepository.of({
          finalizeDeletion: () => record("finalize"),
          recordPvcUid: () => Effect.die("unexpected PVC record"),
        }),
      ),
    );
    assert.isTrue(yield* dispatchNextOutboxEvent("worker-1").pipe(Effect.provide(services)));
    assert.deepEqual(yield* Ref.get(calls), ["remove", "finalize", "complete"]);
  }),
);

it.effect("releases a failed event for bounded retry", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const services = Layer.mergeAll(
      projectionConfigLayer,
      Layer.succeed(
        OutboxRepository,
        OutboxRepository.of({
          claimNext: () =>
            Effect.succeed(
              Option.some({
                id: "1",
                aggregateType: "workspace",
                aggregateId: workspaceId,
                eventType: "workspace.created",
                payload: {},
                attemptCount: 1,
              }),
            ),
          complete: () => Effect.void,
          fail: () => Ref.update(calls, (items) => [...items, "fail"]),
        }),
      ),
      Layer.succeed(
        WorkspaceProjection,
        WorkspaceProjection.of({
          getResource: () => Effect.succeed({ volumeId: "volume-1", resource }),
        }),
      ),
      Layer.succeed(
        WorkspaceResourcePublisher,
        WorkspaceResourcePublisher.of({
          apply: () =>
            Effect.fail(
              new WorkspaceResourcePublisherError({
                reason: "kubernetes_request_failed",
                cause: "unavailable",
              }),
            ),
          remove: () => Effect.succeed({ complete: true }),
        }),
      ),
      Layer.succeed(
        WorkspaceVolumeRepository,
        WorkspaceVolumeRepository.of({
          finalizeDeletion: () => Effect.void,
          recordPvcUid: () => Effect.void,
        }),
      ),
    );
    assert.isFalse(yield* dispatchNextOutboxEvent("worker-1").pipe(Effect.provide(services)));
    assert.deepEqual(yield* Ref.get(calls), ["fail"]);
  }),
);
