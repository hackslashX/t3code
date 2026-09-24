import {
  type CreateWorkspaceRequest,
  type ExistingVolumeOption,
  type OrganizationId,
  type OrganizationQuota,
  type StorageClassOption,
  type UpdateWorkspaceDesiredStateRequest,
  type Workspace,
} from "@t3tools/hosted-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const WorkspacePolicyRejectionReason = Schema.Literals([
  "image_profile_not_allowed",
  "egress_profile_not_allowed",
  "node_name_not_allowed",
  "storage_class_not_allowed",
  "storage_size_not_allowed",
  "storage_access_mode_not_allowed",
  "volume_not_available",
  "gpu_class_not_allowed",
  "gpu_count_not_allowed",
  "workspace_quota_exceeded",
  "running_workspace_quota_exceeded",
  "cpu_quota_exceeded",
  "memory_quota_exceeded",
  "storage_quota_exceeded",
  "gpu_quota_exceeded",
  "stale_generation",
]);
export type WorkspacePolicyRejectionReason = typeof WorkspacePolicyRejectionReason.Type;

export class WorkspacePolicyRejectedError extends Schema.TaggedErrorClass<WorkspacePolicyRejectedError>()(
  "WorkspacePolicyRejectedError",
  { reason: WorkspacePolicyRejectionReason },
) {}

export interface WorkspaceResourceUsage {
  readonly workspaceCount: number;
  readonly runningWorkspaceCount: number;
  readonly cpuMillis: number;
  readonly memoryBytes: number;
  readonly storageBytes: number;
  readonly gpuByClass: ReadonlyMap<string, number>;
}

export interface WorkspaceAdmissionPolicy {
  readonly organizationId: OrganizationId;
  readonly quota: OrganizationQuota;
  readonly usage: WorkspaceResourceUsage;
  readonly imageProfiles: ReadonlySet<string>;
  readonly egressProfiles: ReadonlySet<string>;
  readonly nodes: ReadonlySet<string>;
  readonly storageClasses: ReadonlyMap<string, StorageClassOption>;
  readonly existingVolumes: ReadonlyMap<string, ExistingVolumeOption>;
  readonly gpuClassMaximums: ReadonlyMap<string, number>;
}

const reject = (reason: WorkspacePolicyRejectionReason) =>
  Effect.fail(new WorkspacePolicyRejectedError({ reason }));

export const validateWorkspaceCreate = Effect.fn("WorkspacePolicy.validateCreate")(function* (
  request: CreateWorkspaceRequest,
  policy: WorkspaceAdmissionPolicy,
) {
  if (!policy.imageProfiles.has(request.imageProfile)) {
    return yield* reject("image_profile_not_allowed");
  }
  if (!policy.egressProfiles.has(request.egressProfile)) {
    return yield* reject("egress_profile_not_allowed");
  }
  if (!policy.nodes.has(request.nodeName)) {
    return yield* reject("node_name_not_allowed");
  }

  let requestedStorageBytes = 0;
  if (request.storage.kind === "new") {
    const storageClass = policy.storageClasses.get(request.storage.storageClass);
    if (storageClass === undefined) return yield* reject("storage_class_not_allowed");
    if (
      request.storage.requestedBytes < storageClass.minimumBytes ||
      request.storage.requestedBytes > storageClass.maximumBytes
    ) {
      return yield* reject("storage_size_not_allowed");
    }
    if (!storageClass.allowedAccessModes.includes(request.storage.accessMode)) {
      return yield* reject("storage_access_mode_not_allowed");
    }
    requestedStorageBytes = request.storage.requestedBytes;
  } else {
    const volume = policy.existingVolumes.get(request.storage.volumeId);
    if (
      volume === undefined ||
      volume.organizationId !== policy.organizationId ||
      volume.status !== "available"
    ) {
      return yield* reject("volume_not_available");
    }
  }

  const gpu = request.resources.gpu;
  if (gpu !== undefined) {
    const policyMaximum = policy.gpuClassMaximums.get(gpu.className);
    if (policyMaximum === undefined) return yield* reject("gpu_class_not_allowed");
    if (gpu.count > policyMaximum) return yield* reject("gpu_count_not_allowed");
    const quotaMaximum = policy.quota.maxGpuByClass[gpu.className] ?? 0;
    const current = policy.usage.gpuByClass.get(gpu.className) ?? 0;
    if (current + gpu.count > quotaMaximum) return yield* reject("gpu_quota_exceeded");
  }

  if (policy.usage.workspaceCount + 1 > policy.quota.maxWorkspaces) {
    return yield* reject("workspace_quota_exceeded");
  }
  if (policy.usage.cpuMillis + request.resources.cpuLimitMillis > policy.quota.maxCpuMillis) {
    return yield* reject("cpu_quota_exceeded");
  }
  if (policy.usage.memoryBytes + request.resources.memoryLimitBytes > policy.quota.maxMemoryBytes) {
    return yield* reject("memory_quota_exceeded");
  }
  if (policy.usage.storageBytes + requestedStorageBytes > policy.quota.maxStorageBytes) {
    return yield* reject("storage_quota_exceeded");
  }
});

export const decideDesiredStateChange = Effect.fn("WorkspacePolicy.decideDesiredStateChange")(
  function* (
    workspace: Pick<Workspace, "desiredState" | "generation">,
    request: UpdateWorkspaceDesiredStateRequest,
    input: {
      readonly runningWorkspaceCount: number;
      readonly maxRunningWorkspaces: number;
    },
  ) {
    if (request.expectedGeneration !== workspace.generation) {
      return yield* reject("stale_generation");
    }
    if (request.desiredState === workspace.desiredState) return workspace;
    if (
      request.desiredState === "Running" &&
      input.runningWorkspaceCount + 1 > input.maxRunningWorkspaces
    ) {
      return yield* reject("running_workspace_quota_exceeded");
    }
    return {
      desiredState: request.desiredState,
      generation: workspace.generation + 1,
    };
  },
);
