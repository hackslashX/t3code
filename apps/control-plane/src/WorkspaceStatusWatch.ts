import { CustomObjectsApi, type KubeConfig } from "@kubernetes/client-node";

import { WorkspaceScheduler } from "./operator/WorkspaceScheduler.ts";
import { WorkspaceWatch } from "./operator/WorkspaceWatch.ts";

const GROUP = "hosted.t3.codes";
const VERSION = "v1alpha1";
const PLURAL = "t3workspaces";

export interface WorkspaceStatusWatchOptions {
  readonly namespace: string;
  readonly kubeConfig: KubeConfig;
  readonly signal?: AbortSignal;
  readonly project: (resource: unknown) => Promise<void>;
  readonly onError?: (error: unknown, attempt: number) => void;
}

export async function runWorkspaceStatusWatch(options: WorkspaceStatusWatchOptions): Promise<void> {
  const custom = options.kubeConfig.makeApiClient(CustomObjectsApi);
  const scheduler = new WorkspaceScheduler({
    reconcile: async (key) => {
      const resource = await custom.getNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: key.namespace,
        plural: PLURAL,
        name: key.name,
      });
      await options.project(resource);
    },
    ...(options.onError === undefined
      ? {}
      : { onError: (_key, error, attempt) => options.onError?.(error, attempt) }),
  });
  const watch = new WorkspaceWatch({
    kubeConfig: options.kubeConfig,
    namespace: options.namespace,
    enqueue: (key) => scheduler.enqueue(key),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const stop = () => {
    watch.stop();
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
  }
}
