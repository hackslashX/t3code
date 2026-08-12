import {
  CreateOrganizationInvitationRequest,
  CreateOrganizationInvitationResponse,
  CreateWorkspaceRequest,
  DeleteWorkspaceRequest,
  ExistingVolumeOption,
  MigrateWorkspaceRequest,
  OrganizationId,
  OrganizationMemberSummary,
  RenameOrganizationRequest,
  UpdateOrganizationMemberRequest,
  RenameOrganizationResponse,
  StorageClassOption,
  UpdateWorkspaceDesiredStateRequest,
  WorkspaceId,
  WorkspaceImageProfileOption,
  WorkspaceSummary,
} from "@t3tools/hosted-contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const IdentitySummary = Schema.Struct({
  principal: Schema.Struct({
    id: Schema.String,
    displayName: Schema.String,
    email: Schema.String,
    avatarUrl: Schema.optionalKey(Schema.String),
  }),
  organizations: Schema.Array(
    Schema.Struct({
      id: OrganizationId,
      slug: Schema.String,
      name: Schema.String,
      role: Schema.Literals(["owner", "admin", "member", "viewer"]),
    }),
  ),
});
export type IdentitySummary = typeof IdentitySummary.Type;

const WorkspaceList = Schema.Struct({ workspaces: Schema.Array(WorkspaceSummary) });
const OrganizationMemberList = Schema.Struct({ members: Schema.Array(OrganizationMemberSummary) });
export type OrganizationMember = typeof OrganizationMemberSummary.Type;
const WorkspaceResponse = Schema.Struct({ workspace: WorkspaceSummary });
const StorageOptionsResponse = Schema.Struct({
  nodes: Schema.Array(Schema.String),
  imageProfiles: Schema.Array(WorkspaceImageProfileOption),
  storageClasses: Schema.Array(StorageClassOption),
  existingVolumes: Schema.Array(ExistingVolumeOption),
});
export type StorageOptions = typeof StorageOptionsResponse.Type;

const MigrationResponse = Schema.Struct({
  workspaceId: WorkspaceId,
  generation: Schema.Int,
  imageRevision: Schema.String,
  changed: Schema.Boolean,
});
export type MigrationResult = typeof MigrationResponse.Type;

const DesiredStateResponse = Schema.Struct({
  workspaceId: WorkspaceId,
  desiredState: Schema.Literals(["Running", "Stopped"]),
  generation: Schema.Int,
  changed: Schema.Boolean,
});
export type DesiredStateResult = typeof DesiredStateResponse.Type;

const DeleteResponse = Schema.Struct({
  workspaceId: WorkspaceId,
  generation: Schema.Int,
});
export type DeleteResult = typeof DeleteResponse.Type;

const ProxySessionResponse = Schema.Struct({
  workspaceId: WorkspaceId,
  expiresAtEpochSeconds: Schema.Int,
  t3Url: Schema.String,
  codeServerUrl: Schema.String,
});
export type ProxySession = typeof ProxySessionResponse.Type;

export class HostedControlPlaneError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "HostedControlPlaneError";
    this.status = status;
    this.code = code;
  }
}

export interface HostedControlPlaneClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

const relativeBase = (value: string | undefined) => value?.replace(/\/$/, "") ?? "";

export function makeHostedControlPlaneClient(options: HostedControlPlaneClientOptions = {}) {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = relativeBase(options.baseUrl);

  const request = async <A>(
    path: string,
    schema: Schema.Codec<A, unknown>,
    init?: RequestInit,
  ): Promise<A> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        accept: "application/json",
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const code = Schema.is(Schema.Struct({ error: Schema.String }))(body)
        ? body.error
        : "request_failed";
      throw new HostedControlPlaneError(response.status, code);
    }
    return Schema.decodeUnknownSync(schema)(body);
  };

  const requestVoid = async (path: string, init: RequestInit): Promise<void> => {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => undefined);
      const code = Schema.is(Schema.Struct({ error: Schema.String }))(body)
        ? body.error
        : "request_failed";
      throw new HostedControlPlaneError(response.status, code);
    }
  };

  const organizationPath = (organizationId: OrganizationId) =>
    `/api/organizations/${encodeURIComponent(organizationId)}`;

  return {
    me: () => request("/api/me", IdentitySummary),
    listWorkspaces: (organizationId: OrganizationId) =>
      request(`${organizationPath(organizationId)}/workspaces`, WorkspaceList).then(
        ({ workspaces }) => workspaces,
      ),
    getWorkspace: (organizationId: OrganizationId, workspaceId: WorkspaceId) =>
      request(
        `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}`,
        WorkspaceResponse,
      ).then(({ workspace }) => workspace),
    storageOptions: (organizationId: OrganizationId) =>
      request(`${organizationPath(organizationId)}/storage-options`, StorageOptionsResponse),
    renameOrganization: (organizationId: OrganizationId, input: RenameOrganizationRequest) =>
      request(organizationPath(organizationId), RenameOrganizationResponse, {
        method: "PATCH",
        body: JSON.stringify(Schema.encodeSync(RenameOrganizationRequest)(input)),
      }),
    listMembers: (organizationId: OrganizationId) =>
      request(`${organizationPath(organizationId)}/members`, OrganizationMemberList).then(
        ({ members }) => members,
      ),
    updateMemberRole: (
      organizationId: OrganizationId,
      principalId: string,
      input: UpdateOrganizationMemberRequest,
    ) =>
      requestVoid(
        `${organizationPath(organizationId)}/members/${encodeURIComponent(principalId)}`,
        {
          method: "PATCH",
          body: JSON.stringify(Schema.encodeSync(UpdateOrganizationMemberRequest)(input)),
          headers: { "content-type": "application/json" },
        },
      ),
    createInvitation: (
      organizationId: OrganizationId,
      input: CreateOrganizationInvitationRequest,
    ) =>
      request(
        `${organizationPath(organizationId)}/invitations`,
        CreateOrganizationInvitationResponse,
        {
          method: "POST",
          body: JSON.stringify(Schema.encodeSync(CreateOrganizationInvitationRequest)(input)),
        },
      ),
    revokeInvitation: (organizationId: OrganizationId, invitationId: string) =>
      requestVoid(
        `${organizationPath(organizationId)}/invitations/${encodeURIComponent(invitationId)}/revoke`,
        { method: "POST" },
      ),
    createWorkspace: (organizationId: OrganizationId, input: CreateWorkspaceRequest) =>
      request(`${organizationPath(organizationId)}/workspaces`, WorkspaceResponse, {
        method: "POST",
        body: JSON.stringify(Schema.encodeSync(CreateWorkspaceRequest)(input)),
      }).then(({ workspace }) => workspace),
    migrateImage: (
      organizationId: OrganizationId,
      workspaceId: WorkspaceId,
      input: MigrateWorkspaceRequest,
    ) =>
      request(
        `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/migrate-image`,
        MigrationResponse,
        { method: "POST", body: JSON.stringify(Schema.encodeSync(MigrateWorkspaceRequest)(input)) },
      ),
    setDesiredState: (
      organizationId: OrganizationId,
      workspaceId: WorkspaceId,
      input: UpdateWorkspaceDesiredStateRequest,
    ) =>
      request(
        `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/desired-state`,
        DesiredStateResponse,
        {
          method: "POST",
          body: JSON.stringify(Schema.encodeSync(UpdateWorkspaceDesiredStateRequest)(input)),
        },
      ),
    deleteWorkspace: (
      organizationId: OrganizationId,
      workspaceId: WorkspaceId,
      input: DeleteWorkspaceRequest,
    ) =>
      request(
        `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}`,
        DeleteResponse,
        {
          method: "DELETE",
          body: JSON.stringify(Schema.encodeSync(DeleteWorkspaceRequest)(input)),
        },
      ),
    createProxySession: (organizationId: OrganizationId, workspaceId: WorkspaceId) =>
      request(
        `${organizationPath(organizationId)}/workspaces/${encodeURIComponent(workspaceId)}/proxy-session`,
        ProxySessionResponse,
        { method: "POST", body: "{}" },
      ),
    logout: () => requestVoid("/auth/logout", { method: "POST" }),
    proxySessionExpiresAt: (session: ProxySession) =>
      DateTime.makeUnsafe(session.expiresAtEpochSeconds * 1_000),
  } as const;
}
