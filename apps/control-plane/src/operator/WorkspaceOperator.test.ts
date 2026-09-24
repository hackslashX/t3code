import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { KubernetesWorkspaceClient } from "./KubernetesWorkspaceClient.ts";
import { reconcileWorkspace } from "./WorkspaceOperator.ts";
import type { T3WorkspaceResource } from "./WorkspaceRenderer.ts";

const workspace: T3WorkspaceResource = {
  metadata: { name: "workspace-1", namespace: "hosted", generation: 2 },
  spec: {
    organizationId: "00000000-0000-0000-0000-000000000010",
    workspaceId: "00000000-0000-0000-0000-000000000020",
    desiredState: "Running",
    workspaceGeneration: 1,
    pvcName: "workspace-1",
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

it.effect("skips resources already undergoing foreground deletion", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (value: string) => Ref.update(calls, (items) => [...items, value]);
    const deleting = {
      ...workspace,
      metadata: { ...workspace.metadata, deletionTimestamp: "2026-08-09T00:00:00Z" },
    };
    const client = KubernetesWorkspaceClient.of({
      getWorkspace: () => Effect.succeed(deleting),
      observe: () => record("observe").pipe(Effect.as({})),
      applyService: () => record("service"),
      applyNetworkPolicy: () => record("network-policy"),
      applyPod: () => record("pod"),
      deletePod: () => record("delete-pod"),
      patchStatusIfChanged: () => record("status"),
    });
    const decision = yield* reconcileWorkspace("hosted", "workspace-1").pipe(
      Effect.provide(Layer.succeed(KubernetesWorkspaceClient, client)),
    );
    assert.equal(decision.status.phase, "Deleting");
    assert.deepEqual(yield* Ref.get(calls), []);
  }),
);

it.effect("executes restart-safe reconciliation actions in order", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (value: string) => Ref.update(calls, (items) => [...items, value]);
    const client = KubernetesWorkspaceClient.of({
      getWorkspace: () => Effect.succeed(workspace),
      observe: () => Effect.succeed({ pvcPhase: "Bound" }),
      applyService: () => record("service"),
      applyNetworkPolicy: () => record("network-policy"),
      applyPod: () => record("pod"),
      deletePod: () => record("delete-pod"),
      patchStatusIfChanged: (_workspace, status) => record(`status:${status.phase}`),
    });
    const decision = yield* reconcileWorkspace("hosted", "workspace-1").pipe(
      Effect.provide(Layer.succeed(KubernetesWorkspaceClient, client)),
    );
    assert.equal(decision.status.phase, "Starting");
    assert.deepEqual(yield* Ref.get(calls), [
      "service",
      "network-policy",
      "pod",
      "status:Starting",
    ]);
  }),
);
