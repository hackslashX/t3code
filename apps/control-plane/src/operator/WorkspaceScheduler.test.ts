import { assert, it } from "@effect/vitest";

import { WorkspaceScheduler } from "./WorkspaceScheduler.ts";

it("coalesces events while one workspace reconciliation is running", async () => {
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  const scheduler = new WorkspaceScheduler({
    reconcile: async () => {
      calls += 1;
      if (calls === 1) await firstGate;
    },
  });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-1" });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-1" });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-1" });
  assert.equal(calls, 1);
  releaseFirst?.();
  await scheduler.whenIdle();
  assert.equal(calls, 2);
});

it("runs distinct workspaces independently", async () => {
  const reconciled: Array<string> = [];
  const scheduler = new WorkspaceScheduler({
    reconcile: async (key) => {
      reconciled.push(`${key.namespace}/${key.name}`);
    },
  });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-1" });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-2" });
  await scheduler.whenIdle();
  assert.deepEqual(new Set(reconciled), new Set(["hosted/workspace-1", "hosted/workspace-2"]));
});

it("retries failed reconciliation with injected backoff", async () => {
  let calls = 0;
  const retries: Array<number> = [];
  const scheduler = new WorkspaceScheduler({
    reconcile: async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
    },
    retryDelayMilliseconds: () => 0,
    onError: (_key, _error, attempt) => retries.push(attempt),
  });
  scheduler.enqueue({ namespace: "hosted", name: "workspace-1" });
  await scheduler.whenIdle();
  assert.equal(calls, 2);
  assert.deepEqual(retries, [1]);
});
