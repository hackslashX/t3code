import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as KubernetesConfig from "./KubernetesConfig.ts";
import { loadOperatorConfig } from "./operator/OperatorConfig.ts";
import { runWorkspaceOperator } from "./operator/WorkspaceOperatorRuntime.ts";

class WorkspaceOperatorRuntimeError extends Schema.TaggedErrorClass<WorkspaceOperatorRuntimeError>()(
  "WorkspaceOperatorRuntimeError",
  { cause: Schema.Defect() },
) {}

const program = Effect.gen(function* () {
  const config = yield* loadOperatorConfig;
  const kubeConfig = yield* KubernetesConfig.KubernetesConfig;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  return yield* Effect.callback<void, WorkspaceOperatorRuntimeError>((resume) => {
    const controller = new AbortController();
    void runWorkspaceOperator({
      ...config,
      kubeConfig,
      signal: controller.signal,
      onReconcileError: (key, error, retryAttempt) => {
        runFork(
          Effect.logError("workspace reconciliation failed", {
            namespace: key.namespace,
            name: key.name,
            retryAttempt,
            error,
          }),
        );
      },
      onWatchError: (error, reconnectAttempt) => {
        runFork(Effect.logError("workspace watch failed", { reconnectAttempt, error }));
      },
    }).then(
      () => resume(Effect.void),
      (cause) => resume(Effect.fail(new WorkspaceOperatorRuntimeError({ cause }))),
    );
    return Effect.sync(() => controller.abort());
  });
}).pipe(Effect.provide(Layer.merge(NodeServices.layer, KubernetesConfig.layer)));

if (import.meta.main) NodeRuntime.runMain(program);
