import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as KubernetesWorkspaceClient from "./KubernetesWorkspaceClient.ts";
import { decideWorkspaceReconcile } from "./WorkspaceReconciler.ts";

export const reconcileWorkspace = Effect.fn("WorkspaceOperator.reconcileWorkspace")(function* (
  namespace: string,
  name: string,
) {
  const client = yield* KubernetesWorkspaceClient.KubernetesWorkspaceClient;
  const workspace = yield* client.getWorkspace(namespace, name);
  if (workspace.metadata.deletionTimestamp !== undefined) {
    return {
      actions: [],
      status: {
        observedGeneration: workspace.metadata.generation ?? 0,
        observedWorkspaceGeneration: workspace.spec.workspaceGeneration,
        phase: "Deleting" as const,
        conditions: [],
      },
    };
  }
  const observed = yield* client.observe(workspace);
  const decision = decideWorkspaceReconcile({
    workspace,
    observed,
    now: DateTime.formatIso(yield* DateTime.now),
  });
  for (const action of decision.actions) {
    switch (action.type) {
      case "ApplyService":
        yield* client.applyService(workspace);
        break;
      case "ApplyNetworkPolicy":
        yield* client.applyNetworkPolicy(workspace);
        break;
      case "ApplyPod":
        yield* client.applyPod(workspace);
        break;
      case "DeletePod":
        yield* client.deletePod(workspace);
        break;
    }
  }
  yield* client.patchStatusIfChanged(workspace, decision.status);
  return decision;
});
