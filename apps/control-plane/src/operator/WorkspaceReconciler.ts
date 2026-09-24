import type { T3WorkspaceResource } from "./WorkspaceRenderer.ts";

export interface ObservedWorkspaceResources {
  readonly currentConditions?: ReadonlyArray<WorkspaceStatusCondition>;
  readonly pvcPhase?: "Pending" | "Bound" | "Lost";
  readonly pod?: {
    readonly phase: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
    readonly ready: boolean;
    readonly reason?: string;
    readonly message?: string;
  };
}

export type WorkspaceReconcileAction =
  | { readonly type: "ApplyService" }
  | { readonly type: "ApplyNetworkPolicy" }
  | { readonly type: "ApplyPod" }
  | { readonly type: "DeletePod" };

export interface WorkspaceStatusCondition {
  readonly type: "StorageReady" | "PodReady" | "Ready";
  readonly status: "True" | "False" | "Unknown";
  readonly reason: string;
  readonly message: string;
  readonly observedGeneration: number;
  readonly lastTransitionTime: string;
}

export interface WorkspaceReconcileDecision {
  readonly actions: ReadonlyArray<WorkspaceReconcileAction>;
  readonly status: {
    readonly observedGeneration: number;
    readonly observedWorkspaceGeneration?: number;
    readonly phase: "Starting" | "Ready" | "Stopping" | "Stopped" | "Failed";
    readonly conditions: ReadonlyArray<WorkspaceStatusCondition>;
  };
  readonly requeueAfterSeconds?: number;
}

const condition = (
  type: WorkspaceStatusCondition["type"],
  status: WorkspaceStatusCondition["status"],
  reason: string,
  message: string,
  generation: number,
  now: string,
): WorkspaceStatusCondition => ({
  type,
  status,
  reason,
  message,
  observedGeneration: generation,
  lastTransitionTime: now,
});

function decide(input: {
  readonly workspace: T3WorkspaceResource;
  readonly observed: ObservedWorkspaceResources;
  readonly now: string;
}): WorkspaceReconcileDecision {
  const generation = input.workspace.metadata.generation ?? 0;
  const commonActions: ReadonlyArray<WorkspaceReconcileAction> = [
    { type: "ApplyService" },
    { type: "ApplyNetworkPolicy" },
  ];
  if (input.workspace.spec.desiredState === "Stopped") {
    if (input.observed.pod !== undefined) {
      return {
        actions: [...commonActions, { type: "DeletePod" }],
        status: {
          observedGeneration: generation,
          phase: "Stopping",
          conditions: [
            condition(
              "Ready",
              "False",
              "Stopping",
              "Workspace pod is being removed.",
              generation,
              input.now,
            ),
          ],
        },
        requeueAfterSeconds: 2,
      };
    }
    return {
      actions: commonActions,
      status: {
        observedGeneration: generation,
        phase: "Stopped",
        conditions: [
          condition("PodReady", "False", "Stopped", "Workspace is stopped.", generation, input.now),
          condition("Ready", "False", "Stopped", "Workspace is stopped.", generation, input.now),
        ],
      },
    };
  }

  if (input.observed.pvcPhase === "Lost") {
    return {
      actions: commonActions,
      status: {
        observedGeneration: generation,
        phase: "Failed",
        conditions: [
          condition(
            "StorageReady",
            "False",
            "VolumeLost",
            "Workspace volume is lost.",
            generation,
            input.now,
          ),
          condition(
            "Ready",
            "False",
            "VolumeLost",
            "Workspace cannot start without storage.",
            generation,
            input.now,
          ),
        ],
      },
    };
  }
  if (input.observed.pvcPhase !== "Bound") {
    return {
      actions: commonActions,
      status: {
        observedGeneration: generation,
        phase: "Starting",
        conditions: [
          condition(
            "StorageReady",
            "False",
            "VolumePending",
            "Waiting for the workspace volume.",
            generation,
            input.now,
          ),
          condition(
            "Ready",
            "False",
            "VolumePending",
            "Workspace is waiting for storage.",
            generation,
            input.now,
          ),
        ],
      },
      requeueAfterSeconds: 5,
    };
  }
  if (input.observed.pod === undefined) {
    return {
      actions: [...commonActions, { type: "ApplyPod" }],
      status: {
        observedGeneration: generation,
        phase: "Starting",
        conditions: [
          condition(
            "StorageReady",
            "True",
            "VolumeBound",
            "Workspace volume is bound.",
            generation,
            input.now,
          ),
          condition(
            "PodReady",
            "False",
            "PodCreating",
            "Workspace pod is being created.",
            generation,
            input.now,
          ),
          condition(
            "Ready",
            "False",
            "PodCreating",
            "Workspace is starting.",
            generation,
            input.now,
          ),
        ],
      },
      requeueAfterSeconds: 2,
    };
  }
  if (input.observed.pod.phase === "Failed" || input.observed.pod.phase === "Succeeded") {
    const reason = input.observed.pod.reason ?? "PodTerminated";
    return {
      actions: commonActions,
      status: {
        observedGeneration: generation,
        phase: "Failed",
        conditions: [
          condition(
            "StorageReady",
            "True",
            "VolumeBound",
            "Workspace volume is bound.",
            generation,
            input.now,
          ),
          condition(
            "PodReady",
            "False",
            reason,
            input.observed.pod.message ?? "Workspace pod terminated.",
            generation,
            input.now,
          ),
          condition("Ready", "False", reason, "Workspace failed to start.", generation, input.now),
        ],
      },
    };
  }
  if (!input.observed.pod.ready) {
    return {
      actions: commonActions,
      status: {
        observedGeneration: generation,
        phase: "Starting",
        conditions: [
          condition(
            "StorageReady",
            "True",
            "VolumeBound",
            "Workspace volume is bound.",
            generation,
            input.now,
          ),
          condition(
            "PodReady",
            "False",
            "ContainersNotReady",
            "Waiting for workspace containers.",
            generation,
            input.now,
          ),
          condition(
            "Ready",
            "False",
            "ContainersNotReady",
            "Workspace is starting.",
            generation,
            input.now,
          ),
        ],
      },
      requeueAfterSeconds: 3,
    };
  }
  return {
    actions: commonActions,
    status: {
      observedGeneration: generation,
      phase: "Ready",
      conditions: [
        condition(
          "StorageReady",
          "True",
          "VolumeBound",
          "Workspace volume is bound.",
          generation,
          input.now,
        ),
        condition(
          "PodReady",
          "True",
          "ContainersReady",
          "Workspace containers are ready.",
          generation,
          input.now,
        ),
        condition("Ready", "True", "WorkspaceReady", "Workspace is ready.", generation, input.now),
      ],
    },
  };
}

export function decideWorkspaceReconcile(input: {
  readonly workspace: T3WorkspaceResource;
  readonly observed: ObservedWorkspaceResources;
  readonly now: string;
}): WorkspaceReconcileDecision {
  const decision = decide(input);
  const previous = new Map(
    (input.observed.currentConditions ?? []).map((item) => [item.type, item]),
  );
  return {
    ...decision,
    status: {
      ...decision.status,
      observedWorkspaceGeneration: input.workspace.spec.workspaceGeneration,
      conditions: decision.status.conditions.map((next) => {
        const current = previous.get(next.type);
        return current !== undefined &&
          current.status === next.status &&
          current.reason === next.reason &&
          current.message === next.message
          ? { ...next, lastTransitionTime: current.lastTransitionTime }
          : next;
      }),
    },
  };
}
