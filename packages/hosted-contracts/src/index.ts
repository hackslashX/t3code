import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

const TrimmedNonEmptyString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim()),
      encode: (value) => Effect.succeed(value.trim()),
    }),
  ),
  Schema.check(Schema.isNonEmpty()),
);
const makeId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

export const PrincipalId = makeId("HostedPrincipalId");
export type PrincipalId = typeof PrincipalId.Type;
export const OrganizationId = makeId("HostedOrganizationId");
export type OrganizationId = typeof OrganizationId.Type;
export const WorkspaceId = makeId("HostedWorkspaceId");
export type WorkspaceId = typeof WorkspaceId.Type;
export const WorkspaceVolumeId = makeId("HostedWorkspaceVolumeId");
export type WorkspaceVolumeId = typeof WorkspaceVolumeId.Type;

export const OrganizationRole = Schema.Literals(["owner", "admin", "member", "viewer"]);
export type OrganizationRole = typeof OrganizationRole.Type;
export const MembershipStatus = Schema.Literals(["invited", "active", "suspended"]);
export type MembershipStatus = typeof MembershipStatus.Type;

export const CreateOrganizationInvitationRequest = Schema.Struct({
  email: TrimmedNonEmptyString,
  role: Schema.Literals(["admin", "member", "viewer"]),
  expiresInSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 2_592_000 })),
  ),
});
export type CreateOrganizationInvitationRequest = typeof CreateOrganizationInvitationRequest.Type;

export const CreateOrganizationInvitationResponse = Schema.Struct({
  invitationId: TrimmedNonEmptyString,
  token: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type CreateOrganizationInvitationResponse = typeof CreateOrganizationInvitationResponse.Type;

export const Principal = Schema.Struct({
  id: PrincipalId,
  displayName: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  avatarUrl: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["active", "suspended"]),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Principal = typeof Principal.Type;

export const Organization = Schema.Struct({
  id: OrganizationId,
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: Schema.Literals(["active", "suspended"]),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Organization = typeof Organization.Type;

export const RenameOrganizationRequest = Schema.Struct({
  name: TrimmedNonEmptyString,
});
export type RenameOrganizationRequest = typeof RenameOrganizationRequest.Type;

export const RenameOrganizationResponse = Schema.Struct({
  organizationId: OrganizationId,
  name: TrimmedNonEmptyString,
});
export type RenameOrganizationResponse = typeof RenameOrganizationResponse.Type;

export const OrganizationMembership = Schema.Struct({
  organizationId: OrganizationId,
  principalId: PrincipalId,
  role: OrganizationRole,
  status: MembershipStatus,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type OrganizationMembership = typeof OrganizationMembership.Type;

export const OrganizationMemberSummary = Schema.Struct({
  principalId: PrincipalId,
  displayName: TrimmedNonEmptyString,
  email: TrimmedNonEmptyString,
  avatarUrl: Schema.optionalKey(Schema.String),
  role: OrganizationRole,
  status: MembershipStatus,
});
export type OrganizationMemberSummary = typeof OrganizationMemberSummary.Type;

export const UpdateOrganizationMemberRequest = Schema.Struct({
  role: Schema.Literals(["admin", "member", "viewer"]),
});
export type UpdateOrganizationMemberRequest = typeof UpdateOrganizationMemberRequest.Type;

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const WorkspaceResources = Schema.Struct({
  cpuRequestMillis: PositiveInt,
  cpuLimitMillis: PositiveInt,
  memoryRequestBytes: PositiveInt,
  memoryLimitBytes: PositiveInt,
  ephemeralStorageBytes: PositiveInt,
  gpu: Schema.optionalKey(
    Schema.Struct({
      className: TrimmedNonEmptyString,
      count: PositiveInt,
    }),
  ),
}).check(
  Schema.makeFilter(
    (resources) =>
      (resources.cpuRequestMillis <= resources.cpuLimitMillis &&
        resources.memoryRequestBytes <= resources.memoryLimitBytes) ||
      "resource requests must not exceed limits",
    { title: "workspace resource requests do not exceed limits" },
  ),
);
export type WorkspaceResources = typeof WorkspaceResources.Type;

export const NewWorkspaceStorage = Schema.Struct({
  kind: Schema.Literal("new"),
  storageClass: TrimmedNonEmptyString,
  requestedBytes: PositiveInt,
  accessMode: Schema.Literals(["ReadWriteOnce", "ReadWriteMany"]),
  retentionPolicy: Schema.Literals(["retain", "delete"]),
});
export type NewWorkspaceStorage = typeof NewWorkspaceStorage.Type;

export const ExistingWorkspaceStorage = Schema.Struct({
  kind: Schema.Literal("existing"),
  volumeId: WorkspaceVolumeId,
});
export type ExistingWorkspaceStorage = typeof ExistingWorkspaceStorage.Type;

export const WorkspaceStorage = Schema.Union([NewWorkspaceStorage, ExistingWorkspaceStorage]);
export type WorkspaceStorage = typeof WorkspaceStorage.Type;

export const WorkspaceDesiredState = Schema.Literals(["Running", "Stopped"]);
export type WorkspaceDesiredState = typeof WorkspaceDesiredState.Type;
export const WorkspacePhase = Schema.Literals([
  "Starting",
  "Ready",
  "Stopping",
  "Stopped",
  "Failed",
  "Deleting",
]);
export type WorkspacePhase = typeof WorkspacePhase.Type;

export const WorkspaceConditionType = Schema.Literals([
  "StorageReady",
  "Scheduled",
  "PodReady",
  "RouteReady",
  "Authenticated",
]);
export type WorkspaceConditionType = typeof WorkspaceConditionType.Type;

export const WorkspaceCondition = Schema.Struct({
  type: WorkspaceConditionType,
  status: Schema.Literals(["True", "False", "Unknown"]),
  reason: TrimmedNonEmptyString,
  message: Schema.String,
  observedGeneration: NonNegativeInt,
  lastTransitionTime: Schema.DateTimeUtcFromString,
});
export type WorkspaceCondition = typeof WorkspaceCondition.Type;

export const WorkspaceSpec = Schema.Struct({
  name: TrimmedNonEmptyString,
  nodeName: TrimmedNonEmptyString,
  imageProfile: TrimmedNonEmptyString,
  resources: WorkspaceResources,
  storage: WorkspaceStorage,
  egressProfile: TrimmedNonEmptyString,
});
export type WorkspaceSpec = typeof WorkspaceSpec.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  organizationId: OrganizationId,
  ownerPrincipalId: PrincipalId,
  spec: WorkspaceSpec,
  desiredState: WorkspaceDesiredState,
  generation: NonNegativeInt,
  phase: WorkspacePhase,
  conditions: Schema.Array(WorkspaceCondition),
  routeHost: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(TrimmedNonEmptyString),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceStorageSummary = Schema.Struct({
  capacityBytes: PositiveInt,
  storageClass: TrimmedNonEmptyString,
  accessMode: Schema.Literals(["ReadWriteOnce", "ReadWriteMany"]),
  source: Schema.Literals(["created", "imported"]),
  retentionPolicy: Schema.Literals(["retain", "delete"]),
});
export type WorkspaceStorageSummary = typeof WorkspaceStorageSummary.Type;

export const WorkspaceSummary = Schema.Struct({
  id: WorkspaceId,
  name: TrimmedNonEmptyString,
  slug: TrimmedNonEmptyString,
  desiredState: WorkspaceDesiredState,
  phase: WorkspacePhase,
  generation: NonNegativeInt,
  observedGeneration: NonNegativeInt,
  nodeName: TrimmedNonEmptyString,
  imageProfile: TrimmedNonEmptyString,
  imageRevision: TrimmedNonEmptyString,
  resources: WorkspaceResources,
  storage: WorkspaceStorageSummary,
  egressProfile: TrimmedNonEmptyString,
  routeHost: Schema.optionalKey(TrimmedNonEmptyString),
  environmentId: Schema.optionalKey(TrimmedNonEmptyString),
  failureReason: Schema.optionalKey(TrimmedNonEmptyString),
  failureMessage: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type WorkspaceSummary = typeof WorkspaceSummary.Type;

export const CreateWorkspaceRequest = WorkspaceSpec;
export type CreateWorkspaceRequest = typeof CreateWorkspaceRequest.Type;

export const MigrateWorkspaceRequest = Schema.Struct({
  expectedGeneration: NonNegativeInt,
});
export type MigrateWorkspaceRequest = typeof MigrateWorkspaceRequest.Type;

export const UpdateWorkspaceDesiredStateRequest = Schema.Struct({
  desiredState: WorkspaceDesiredState,
  expectedGeneration: NonNegativeInt,
});
export type UpdateWorkspaceDesiredStateRequest = typeof UpdateWorkspaceDesiredStateRequest.Type;

export const DeleteWorkspaceVolumePolicy = Schema.Literals(["retain", "delete"]);
export type DeleteWorkspaceVolumePolicy = typeof DeleteWorkspaceVolumePolicy.Type;

export const DeleteWorkspaceRequest = Schema.Struct({
  volumePolicy: DeleteWorkspaceVolumePolicy,
  expectedGeneration: NonNegativeInt,
});
export type DeleteWorkspaceRequest = typeof DeleteWorkspaceRequest.Type;

export const OrganizationQuota = Schema.Struct({
  organizationId: OrganizationId,
  maxWorkspaces: PositiveInt,
  maxRunningWorkspaces: PositiveInt,
  maxCpuMillis: PositiveInt,
  maxMemoryBytes: PositiveInt,
  maxStorageBytes: PositiveInt,
  maxGpuByClass: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
});
export type OrganizationQuota = typeof OrganizationQuota.Type;

export const WorkspaceImageProfileOption = Schema.Struct({
  id: TrimmedNonEmptyString,
  revision: TrimmedNonEmptyString,
});
export type WorkspaceImageProfileOption = typeof WorkspaceImageProfileOption.Type;

export const StorageClassOption = Schema.Struct({
  name: TrimmedNonEmptyString,
  isDefault: Schema.Boolean,
  allowExpansion: Schema.Boolean,
  bindingMode: Schema.Literals(["Immediate", "WaitForFirstConsumer"]),
  allowedAccessModes: Schema.Array(Schema.Literals(["ReadWriteOnce", "ReadWriteMany"])),
  minimumBytes: PositiveInt,
  maximumBytes: PositiveInt,
});
export type StorageClassOption = typeof StorageClassOption.Type;

export const ExistingVolumeOption = Schema.Struct({
  id: WorkspaceVolumeId,
  organizationId: OrganizationId,
  storageClass: TrimmedNonEmptyString,
  capacityBytes: PositiveInt,
  accessMode: Schema.Literals(["ReadWriteOnce", "ReadWriteMany"]),
  status: Schema.Literals(["available", "attached"]),
});
export type ExistingVolumeOption = typeof ExistingVolumeOption.Type;
