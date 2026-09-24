import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { projectWorkspaceStatus } from "./WorkspaceStatusProjector.ts";
import { WorkspaceStatusRepository } from "./WorkspaceStatusRepository.ts";

const resource = {
  metadata: { generation: 5 },
  spec: {
    workspaceId: "00000000-0000-0000-0000-000000000020",
    organizationId: "00000000-0000-0000-0000-000000000010",
    workspaceGeneration: 2,
    routeHost: "workspace.example.test",
  },
  status: {
    observedGeneration: 5,
    observedWorkspaceGeneration: 2,
    phase: "Ready",
    environmentId: "environment-1",
    conditions: [
      {
        type: "StorageReady",
        status: "True",
        reason: "VolumeBound",
        message: "Volume is bound.",
        observedGeneration: 5,
        lastTransitionTime: "2026-06-01T00:00:00.000Z",
      },
      {
        type: "Ready",
        status: "True",
        reason: "WorkspaceReady",
        message: "Workspace is ready.",
        observedGeneration: 5,
        lastTransitionTime: "2026-06-01T00:00:00.000Z",
      },
    ],
  },
};

it.effect("projects matching workspace status and supported conditions", () =>
  Effect.gen(function* () {
    const projected = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const repository = WorkspaceStatusRepository.of({
      project: (input) => Ref.update(projected, (items) => [...items, input]),
    });
    assert.isTrue(
      yield* projectWorkspaceStatus(resource).pipe(
        Effect.provide(Layer.succeed(WorkspaceStatusRepository, repository)),
      ),
    );
    const input = (yield* Ref.get(projected))[0] as {
      readonly observedWorkspaceGeneration: number;
      readonly conditions: ReadonlyArray<{ readonly type: string }>;
    };
    assert.equal(input.observedWorkspaceGeneration, 2);
    assert.deepEqual(
      input.conditions.map((item) => item.type),
      ["StorageReady"],
    );
  }),
);

it.effect("ignores status for an older workspace spec generation", () =>
  Effect.gen(function* () {
    const repository = WorkspaceStatusRepository.of({ project: () => Effect.die("unexpected") });
    assert.isFalse(
      yield* projectWorkspaceStatus({
        ...resource,
        status: { ...resource.status, observedWorkspaceGeneration: 1 },
      }).pipe(Effect.provide(Layer.succeed(WorkspaceStatusRepository, repository))),
    );
  }),
);
