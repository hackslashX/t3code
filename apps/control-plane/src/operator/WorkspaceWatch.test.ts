import { KubeConfig } from "@kubernetes/client-node";
import { assert, it } from "@effect/vitest";

import { WorkspaceWatch } from "./WorkspaceWatch.ts";

it("relists then watches workspace changes", async () => {
  const enqueued: Array<string> = [];
  let releaseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const runtime = new WorkspaceWatch({
    kubeConfig: new KubeConfig(),
    namespace: "hosted",
    enqueue: (key) => enqueued.push(`${key.namespace}/${key.name}`),
    customObjects: {
      listNamespacedCustomObject: async () => ({
        metadata: { resourceVersion: "10" },
        items: [{ metadata: { namespace: "hosted", name: "from-list" } }],
      }),
    },
    watchClient: {
      watch: async (_path, query, callback, done) => {
        assert.equal(query.resourceVersion, "10");
        const controller = new AbortController();
        controller.signal.addEventListener("abort", () => done());
        callback("MODIFIED", { metadata: { name: "from-watch" } });
        releaseStarted?.();
        return controller;
      },
    },
  });
  const running = runtime.run();
  await started;
  runtime.stop();
  await running;
  assert.deepEqual(enqueued, ["hosted/from-list", "hosted/from-watch"]);
});

it("ignores bookmark and deletion events", async () => {
  const enqueued: Array<string> = [];
  let releaseStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve;
  });
  const runtime = new WorkspaceWatch({
    kubeConfig: new KubeConfig(),
    namespace: "hosted",
    enqueue: (key) => enqueued.push(key.name),
    customObjects: {
      listNamespacedCustomObject: async () => ({ metadata: { resourceVersion: "1" }, items: [] }),
    },
    watchClient: {
      watch: async (_path, _query, callback, done) => {
        const controller = new AbortController();
        controller.signal.addEventListener("abort", () => done());
        callback("BOOKMARK", { metadata: { name: "bookmark" } });
        callback("DELETED", { metadata: { name: "deleted" } });
        releaseStarted?.();
        return controller;
      },
    },
  });
  const running = runtime.run();
  await started;
  runtime.stop();
  await running;
  assert.deepEqual(enqueued, []);
});
