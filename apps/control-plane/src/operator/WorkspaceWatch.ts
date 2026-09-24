import { CustomObjectsApi, KubeConfig, Watch } from "@kubernetes/client-node";
import * as Effect from "effect/Effect";

import type { WorkspaceKey } from "./WorkspaceScheduler.ts";

const GROUP = "hosted.t3.codes";
const VERSION = "v1alpha1";
const PLURAL = "t3workspaces";

interface CustomObjectsReader {
  readonly listNamespacedCustomObject: (input: {
    readonly group: string;
    readonly version: string;
    readonly namespace: string;
    readonly plural: string;
  }) => Promise<unknown>;
}

interface WatchClient {
  readonly watch: (
    path: string,
    query: Record<string, string | number | boolean | undefined>,
    callback: (phase: string, object: { readonly metadata?: { readonly name?: string } }) => void,
    done: (error?: unknown) => void,
  ) => Promise<AbortController>;
}

export interface WorkspaceWatchOptions {
  readonly kubeConfig: KubeConfig;
  readonly namespace: string;
  readonly enqueue: (key: WorkspaceKey) => void;
  readonly onError?: (error: unknown, reconnectAttempt: number) => void;
  readonly reconnectDelayMilliseconds?: (attempt: number) => number;
  readonly customObjects?: CustomObjectsReader;
  readonly watchClient?: WatchClient;
}

interface WorkspaceList {
  readonly metadata?: { readonly resourceVersion?: string };
  readonly items?: ReadonlyArray<{
    readonly metadata?: { readonly name?: string; readonly namespace?: string };
  }>;
}

const sleep = (milliseconds: number, signal: AbortSignal) =>
  Effect.runPromise(Effect.sleep(milliseconds), { signal });

export class WorkspaceWatch {
  readonly #options: WorkspaceWatchOptions;
  readonly #customObjects: CustomObjectsReader;
  readonly #watch: WatchClient;
  #stopped = false;
  #abortController: AbortController | undefined;
  readonly #stopController = new AbortController();

  constructor(options: WorkspaceWatchOptions) {
    this.#options = options;
    this.#customObjects =
      options.customObjects ?? options.kubeConfig.makeApiClient(CustomObjectsApi);
    this.#watch = options.watchClient ?? new Watch(options.kubeConfig);
  }

  stop(): void {
    this.#stopped = true;
    this.#stopController.abort();
    this.#abortController?.abort();
  }

  async run(): Promise<void> {
    let reconnectAttempt = 0;
    while (!this.#stopped) {
      try {
        const list = (await this.#customObjects.listNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: this.#options.namespace,
          plural: PLURAL,
        })) as WorkspaceList;
        for (const item of list.items ?? []) {
          const name = item.metadata?.name;
          if (name !== undefined) {
            this.#options.enqueue({
              namespace: item.metadata?.namespace ?? this.#options.namespace,
              name,
            });
          }
        }
        reconnectAttempt = 0;
        await this.#watchOnce(list.metadata?.resourceVersion);
      } catch (error) {
        if (this.#stopped) return;
        reconnectAttempt += 1;
        this.#options.onError?.(error, reconnectAttempt);
        const delay =
          this.#options.reconnectDelayMilliseconds?.(reconnectAttempt) ??
          Math.min(30_000, 500 * 2 ** Math.min(reconnectAttempt - 1, 6));
        try {
          await sleep(delay, this.#stopController.signal);
        } catch {
          if (this.#stopped) return;
        }
      }
    }
  }

  async #watchOnce(resourceVersion: string | undefined): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      void this.#watch
        .watch(
          `/apis/${GROUP}/${VERSION}/namespaces/${this.#options.namespace}/${PLURAL}`,
          { allowWatchBookmarks: true, resourceVersion, timeoutSeconds: 30 },
          (phase, object: { readonly metadata?: { readonly name?: string } }) => {
            if (phase !== "ADDED" && phase !== "MODIFIED") return;
            const name = object.metadata?.name;
            if (name !== undefined) {
              this.#options.enqueue({ namespace: this.#options.namespace, name });
            }
          },
          (error) => {
            this.#abortController = undefined;
            // Kubernetes watch timeouts complete with null; this is a normal relist boundary.
            if (this.#stopped || error === undefined || error === null) resolve();
            else reject(error);
          },
        )
        .then((controller) => {
          this.#abortController = controller;
          if (this.#stopped) controller.abort();
        })
        .catch(reject);
    });
  }
}
