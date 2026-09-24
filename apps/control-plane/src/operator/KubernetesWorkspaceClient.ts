import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ObservedWorkspaceResources,
  WorkspaceReconcileDecision,
} from "./WorkspaceReconciler.ts";
import type { T3WorkspaceResource } from "./WorkspaceRenderer.ts";

export class KubernetesWorkspaceClientError extends Schema.TaggedErrorClass<KubernetesWorkspaceClientError>()(
  "KubernetesWorkspaceClientError",
  {
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class KubernetesWorkspaceClient extends Context.Service<
  KubernetesWorkspaceClient,
  {
    readonly getWorkspace: (
      namespace: string,
      name: string,
    ) => Effect.Effect<T3WorkspaceResource, KubernetesWorkspaceClientError>;
    readonly observe: (
      workspace: T3WorkspaceResource,
    ) => Effect.Effect<ObservedWorkspaceResources, KubernetesWorkspaceClientError>;
    readonly applyService: (
      workspace: T3WorkspaceResource,
    ) => Effect.Effect<void, KubernetesWorkspaceClientError>;
    readonly applyNetworkPolicy: (
      workspace: T3WorkspaceResource,
    ) => Effect.Effect<void, KubernetesWorkspaceClientError>;
    readonly applyPod: (
      workspace: T3WorkspaceResource,
    ) => Effect.Effect<void, KubernetesWorkspaceClientError>;
    readonly deletePod: (
      workspace: T3WorkspaceResource,
    ) => Effect.Effect<void, KubernetesWorkspaceClientError>;
    readonly patchStatusIfChanged: (
      workspace: T3WorkspaceResource,
      status: WorkspaceReconcileDecision["status"],
    ) => Effect.Effect<void, KubernetesWorkspaceClientError>;
  }
>()("@t3tools/control-plane/operator/KubernetesWorkspaceClient") {}
