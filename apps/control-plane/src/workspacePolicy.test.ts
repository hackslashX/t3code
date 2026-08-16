import {
  CreateWorkspaceRequest,
  OrganizationId,
  OrganizationQuota,
  StorageClassOption,
  UpdateWorkspaceDesiredStateRequest,
  ExistingVolumeOption,
} from "@t3tools/hosted-contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  decideDesiredStateChange,
  validateWorkspaceCreate,
  type WorkspaceAdmissionPolicy,
} from "./workspacePolicy.ts";

const organizationId = OrganizationId.make("organization-1");
const request = Schema.decodeUnknownSync(CreateWorkspaceRequest)({
  name: "development",
  nodeName: "orion",
  imageProfile: "stable",
  resources: {
    cpuRequestMillis: 500,
    cpuLimitMillis: 2000,
    memoryRequestBytes: 1_073_741_824,
    memoryLimitBytes: 4_294_967_296,
    ephemeralStorageBytes: 2_147_483_648,
  },
  storage: {
    kind: "new",
    storageClass: "longhorn-ssd-orion",
    requestedBytes: 10_737_418_240,
    accessMode: "ReadWriteOnce",
    retentionPolicy: "retain",
  },
  egressProfile: "standard",
});
const quota = Schema.decodeUnknownSync(OrganizationQuota)({
  organizationId,
  maxWorkspaces: 5,
  maxRunningWorkspaces: 2,
  maxCpuMillis: 8000,
  maxMemoryBytes: 17_179_869_184,
  maxStorageBytes: 107_374_182_400,
  maxGpuByClass: { "nvidia-l4": 1 },
});
const storageClass = Schema.decodeUnknownSync(StorageClassOption)({
  name: "longhorn-ssd-orion",
  isDefault: true,
  allowExpansion: true,
  bindingMode: "Immediate",
  allowedAccessModes: ["ReadWriteOnce"],
  minimumBytes: 1_073_741_824,
  maximumBytes: 107_374_182_400,
});

const makePolicy = (
  overrides: Partial<WorkspaceAdmissionPolicy> = {},
): WorkspaceAdmissionPolicy => ({
  organizationId,
  quota,
  usage: {
    workspaceCount: 0,
    runningWorkspaceCount: 0,
    cpuMillis: 0,
    memoryBytes: 0,
    storageBytes: 0,
    gpuByClass: new Map(),
  },
  imageProfiles: new Set(["stable"]),
  egressProfiles: new Set(["standard", "restricted"]),
  nodes: new Set(["orion", "atlas"]),
  storageClasses: new Map([["longhorn-ssd-orion", storageClass]]),
  existingVolumes: new Map(),
  gpuClassMaximums: new Map([["nvidia-l4", 1]]),
  ...overrides,
});

it.effect("admits a workspace through curated policy", () =>
  validateWorkspaceCreate(request, makePolicy()),
);

it.effect("rejects quota overflow", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      validateWorkspaceCreate(
        request,
        makePolicy({ usage: { ...makePolicy().usage, workspaceCount: 5 } }),
      ),
    );
    assert(exit._tag === "Failure");
  }),
);

it.effect("does not authorize existing storage by volume ID alone", () =>
  Effect.gen(function* () {
    const otherOrganizationVolume = yield* Schema.decodeUnknownEffect(ExistingVolumeOption)({
      id: "volume-1",
      organizationId: "organization-2",
      storageClass: "longhorn-ssd-orion",
      capacityBytes: 10_737_418_240,
      accessMode: "ReadWriteOnce",
      status: "available",
    });
    const existingRequest = yield* Schema.decodeUnknownEffect(CreateWorkspaceRequest)({
      ...request,
      storage: { kind: "existing", volumeId: "volume-1" },
    });
    const exit = yield* Effect.exit(
      validateWorkspaceCreate(
        existingRequest,
        makePolicy({ existingVolumes: new Map([["volume-1", otherOrganizationVolume]]) }),
      ),
    );
    assert(exit._tag === "Failure");
  }),
);

it.effect("changes desired state idempotently with optimistic concurrency", () =>
  Effect.gen(function* () {
    const start = yield* Schema.decodeUnknownEffect(UpdateWorkspaceDesiredStateRequest)({
      desiredState: "Running",
      expectedGeneration: 3,
    });
    const changed = yield* decideDesiredStateChange(
      { desiredState: "Stopped", generation: 3 },
      start,
      { runningWorkspaceCount: 0, maxRunningWorkspaces: 2 },
    );
    assert.deepEqual(changed, { desiredState: "Running", generation: 4 });

    const repeated = yield* decideDesiredStateChange(
      { desiredState: "Running", generation: 4 },
      { desiredState: "Running", expectedGeneration: 4 },
      { runningWorkspaceCount: 1, maxRunningWorkspaces: 2 },
    );
    assert.deepEqual(repeated, { desiredState: "Running", generation: 4 });
  }),
);

it.effect("rejects stale lifecycle updates and running quota overflow", () =>
  Effect.gen(function* () {
    const stale = yield* Effect.exit(
      decideDesiredStateChange(
        { desiredState: "Stopped", generation: 4 },
        { desiredState: "Running", expectedGeneration: 3 },
        { runningWorkspaceCount: 0, maxRunningWorkspaces: 2 },
      ),
    );
    assert(stale._tag === "Failure");

    const quotaExceeded = yield* Effect.exit(
      decideDesiredStateChange(
        { desiredState: "Stopped", generation: 4 },
        { desiredState: "Running", expectedGeneration: 4 },
        { runningWorkspaceCount: 2, maxRunningWorkspaces: 2 },
      ),
    );
    assert(quotaExceeded._tag === "Failure");
  }),
);
