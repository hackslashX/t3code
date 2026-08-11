import type { KubeConfig } from "@kubernetes/client-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { KubernetesConfig } from "../KubernetesConfig.ts";
import * as KubernetesWorkspaceClientLive from "./KubernetesWorkspaceClientLive.ts";
import { reconcileWorkspace } from "./WorkspaceOperator.ts";
import type { WorkspaceRendererOptions } from "./WorkspaceRenderer.ts";
import { WorkspaceScheduler, type WorkspaceKey } from "./WorkspaceScheduler.ts";
import { WorkspaceWatch } from "./WorkspaceWatch.ts";

export interface WorkspaceOperatorRuntimeOptions {
  readonly namespace: string;
  readonly kubeConfig: KubeConfig;
  readonly renderer: WorkspaceRendererOptions;
  readonly signal?: AbortSignal;
  readonly onReconcileError?: (key: WorkspaceKey, error: unknown, retryAttempt: number) => void;
  readonly onWatchError?: (error: unknown, reconnectAttempt: number) => void;
}

export async function runWorkspaceOperator(
  options: WorkspaceOperatorRuntimeOptions,
): Promise<void> {
  const runtime = ManagedRuntime.make(
    KubernetesWorkspaceClientLive.layer(options.renderer).pipe(
      Layer.provide(Layer.succeed(KubernetesConfig, options.kubeConfig)),
    ),
  );
  const requeueTimers = new Map<string, AbortController>();
  let scheduler: WorkspaceScheduler;
  scheduler = new WorkspaceScheduler({
    reconcile: async (key) => {
      const decision = await runtime.runPromise(reconcileWorkspace(key.namespace, key.name));
      if ("requeueAfterSeconds" in decision && decision.requeueAfterSeconds !== undefined) {
        const id = `${key.namespace}/${key.name}`;
        requeueTimers.get(id)?.abort();
        const controller = new AbortController();
        requeueTimers.set(id, controller);
        void Effect.runPromise(Effect.sleep(`${decision.requeueAfterSeconds} seconds`), {
          signal: controller.signal,
        }).then(
          () => {
            requeueTimers.delete(id);
            scheduler.enqueue(key);
          },
          () => {
            requeueTimers.delete(id);
          },
        );
      }
    },
    ...(options.onReconcileError === undefined ? {} : { onError: options.onReconcileError }),
  });
  const watch = new WorkspaceWatch({
    kubeConfig: options.kubeConfig,
    namespace: options.namespace,
    enqueue: (key) => scheduler.enqueue(key),
    ...(options.onWatchError === undefined ? {} : { onError: options.onWatchError }),
  });
  const stop = () => {
    watch.stop();
    for (const controller of requeueTimers.values()) controller.abort();
    requeueTimers.clear();
    scheduler.stop();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted === true) stop();
  try {
    await watch.run();
  } finally {
    options.signal?.removeEventListener("abort", stop);
    stop();
    await scheduler.whenIdle();
    await runtime.dispose();
  }
}
