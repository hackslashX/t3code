import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  CreateOrganizationInvitationRequest,
  CreateWorkspaceRequest,
  UpdateWorkspaceDesiredStateRequest,
} from "./index.ts";

const decodeCreate = Schema.decodeUnknownOption(CreateWorkspaceRequest);

it("validates organization invitation requests", () => {
  const decode = Schema.decodeUnknownOption(CreateOrganizationInvitationRequest);
  const valid = decode({
    email: " user@example.test ",
    role: "member",
    expiresInSeconds: 3600,
  });
  assert(Option.isSome(valid));
  assert.equal(valid.value.email, "user@example.test");
  assert(Option.isNone(decode({ email: "user@example.test", role: "owner" })));
  assert(
    Option.isNone(decode({ email: "user@example.test", role: "viewer", expiresInSeconds: 30 })),
  );
});

it("decodes a policy-shaped workspace request", () => {
  const decoded = decodeCreate({
    name: "  development  ",
    nodeName: "orion",
    imageProfile: "stable",
    resources: {
      cpuRequestMillis: 500,
      cpuLimitMillis: 2000,
      memoryRequestBytes: 1_073_741_824,
      memoryLimitBytes: 4_294_967_296,
      ephemeralStorageBytes: 2_147_483_648,
      gpu: { className: "nvidia-l4", count: 1 },
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

  assert(Option.isSome(decoded));
  assert.equal(decoded.value.name, "development");
  assert.equal(decoded.value.storage.kind, "new");
});

it("decodes existing storage only through a platform volume ID", () => {
  const decoded = decodeCreate({
    name: "existing-volume",
    nodeName: "atlas",
    imageProfile: "stable",
    resources: {
      cpuRequestMillis: 500,
      cpuLimitMillis: 1000,
      memoryRequestBytes: 536_870_912,
      memoryLimitBytes: 1_073_741_824,
      ephemeralStorageBytes: 1_073_741_824,
    },
    storage: { kind: "existing", volumeId: "volume-1" },
    egressProfile: "restricted",
  });

  assert(Option.isSome(decoded));
  assert.equal(decoded.value.storage.kind, "existing");
});

it("rejects invalid resource and storage values", () => {
  const decoded = decodeCreate({
    name: "invalid",
    imageProfile: "stable",
    resources: {
      cpuRequestMillis: 0,
      cpuLimitMillis: 1000,
      memoryRequestBytes: 1,
      memoryLimitBytes: 1,
      ephemeralStorageBytes: 1,
    },
    storage: {
      kind: "new",
      storageClass: "longhorn-ssd-orion",
      requestedBytes: -1,
      accessMode: "ReadWriteOnce",
      retentionPolicy: "retain",
    },
    egressProfile: "standard",
  });

  assert(Option.isNone(decoded));
});

it("rejects resource requests above their limits", () => {
  const decoded = decodeCreate({
    name: "invalid-limits",
    imageProfile: "stable",
    resources: {
      cpuRequestMillis: 2000,
      cpuLimitMillis: 1000,
      memoryRequestBytes: 2_147_483_648,
      memoryLimitBytes: 1_073_741_824,
      ephemeralStorageBytes: 1_073_741_824,
    },
    storage: { kind: "existing", volumeId: "volume-1" },
    egressProfile: "restricted",
  });
  assert(Option.isNone(decoded));
});

it("requires optimistic concurrency on desired-state changes", () => {
  const decode = Schema.decodeUnknownOption(UpdateWorkspaceDesiredStateRequest);
  assert(Option.isSome(decode({ desiredState: "Running", expectedGeneration: 4 })));
  assert(Option.isNone(decode({ desiredState: "Paused", expectedGeneration: 4 })));
  assert(Option.isNone(decode({ desiredState: "Running", expectedGeneration: -1 })));
});
