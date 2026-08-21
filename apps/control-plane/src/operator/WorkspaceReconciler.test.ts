import { assert, it } from "@effect/vitest";

import { decideWorkspaceReconcile } from "./WorkspaceReconciler.ts";
import type { T3WorkspaceResource } from "./WorkspaceRenderer.ts";

const workspace: T3WorkspaceResource = {
  metadata: { name: "workspace-1", namespace: "hosted", generation: 4 },
  spec: {
    organizationId: "00000000-0000-0000-0000-000000000010",
    workspaceId: "00000000-0000-0000-0000-000000000020",
    desiredState: "Running",
    workspaceGeneration: 3,
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
const now = "2026-06-01T00:00:00.000Z";

it("waits for bound storage before creating a pod", () => {
  const decision = decideWorkspaceReconcile({ workspace, observed: { pvcPhase: "Pending" }, now });
  assert.equal(decision.status.phase, "Starting");
  assert.isFalse(decision.actions.some((action) => action.type === "ApplyPod"));
  assert.equal(decision.status.observedGeneration, 4);
  assert.equal(decision.status.observedWorkspaceGeneration, 3);
});

it("creates the pod once storage is bound and becomes ready idempotently", () => {
  const creating = decideWorkspaceReconcile({ workspace, observed: { pvcPhase: "Bound" }, now });
  assert.isTrue(creating.actions.some((action) => action.type === "ApplyPod"));
  const ready = decideWorkspaceReconcile({
    workspace,
    observed: { pvcPhase: "Bound", pod: { phase: "Running", ready: true } },
    now,
  });
  assert.equal(ready.status.phase, "Ready");
  assert.isFalse(ready.actions.some((action) => action.type === "ApplyPod"));
  assert.equal(ready.status.conditions.find((item) => item.type === "Ready")?.status, "True");
  const repeated = decideWorkspaceReconcile({
    workspace,
    observed: {
      pvcPhase: "Bound",
      pod: { phase: "Running", ready: true },
      currentConditions: ready.status.conditions,
    },
    now: "2026-06-01T01:00:00.000Z",
  });
  assert.equal(
    repeated.status.conditions.find((item) => item.type === "Ready")?.lastTransitionTime,
    now,
  );
});

it("deletes a running pod when stopped and settles without another delete", () => {
  const stopped = { ...workspace, spec: { ...workspace.spec, desiredState: "Stopped" as const } };
  const stopping = decideWorkspaceReconcile({
    workspace: stopped,
    observed: { pvcPhase: "Bound", pod: { phase: "Running", ready: true } },
    now,
  });
  assert.equal(stopping.status.phase, "Stopping");
  assert.isTrue(stopping.actions.some((action) => action.type === "DeletePod"));
  const settled = decideWorkspaceReconcile({
    workspace: stopped,
    observed: { pvcPhase: "Bound" },
    now,
  });
  assert.equal(settled.status.phase, "Stopped");
  assert.isFalse(settled.actions.some((action) => action.type === "DeletePod"));
});

it("reports lost storage and terminated pods as failed", () => {
  assert.equal(
    decideWorkspaceReconcile({ workspace, observed: { pvcPhase: "Lost" }, now }).status.phase,
    "Failed",
  );
  assert.equal(
    decideWorkspaceReconcile({
      workspace,
      observed: { pvcPhase: "Bound", pod: { phase: "Failed", ready: false } },
      now,
    }).status.phase,
    "Failed",
  );
});
