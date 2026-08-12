import { createFileRoute } from "@tanstack/react-router";
import {
  HostedControlPlaneError,
  makeHostedControlPlaneClient,
  type IdentitySummary,
  type OrganizationMember,
  type StorageOptions,
} from "@t3tools/client-runtime/control-plane";
import type {
  CreateWorkspaceRequest,
  OrganizationId,
  OrganizationRole,
  WorkspaceSummary,
} from "@t3tools/hosted-contracts";
import {
  Boxes,
  Building2,
  ChevronDown,
  Database,
  ExternalLink,
  HardDrive,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  LogOut,
  MailPlus,
  Play,
  Plus,
  RefreshCw,
  Square,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { T3Wordmark } from "../components/sidebar/SidebarChrome";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "../components/ui/sidebar";
import { cn } from "../lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

export const Route = createFileRoute("/hosted")({ component: HostedDashboard });

type Section = "overview" | "workspaces" | "storage" | "team" | "organization";
type OrganizationSummary = IdentitySummary["organizations"][number];

const client = makeHostedControlPlaneClient();
const gibibyte = 1024 ** 3;

const navigation: ReadonlyArray<{
  readonly id: Section;
  readonly label: string;
  readonly icon: typeof LayoutDashboard;
}> = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "workspaces", label: "Workspaces", icon: Boxes },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "team", label: "Members & invitations", icon: Users },
  { id: "organization", label: "Organization", icon: Building2 },
];

const messageFor = (cause: unknown, fallback: string) => {
  if (cause instanceof HostedControlPlaneError) return cause.code.replaceAll("_", " ");
  return cause instanceof Error ? cause.message : fallback;
};

const roleCanAdminister = (role: OrganizationRole) => role === "owner" || role === "admin";

const phaseTone = (phase: WorkspaceSummary["phase"]) => {
  switch (phase) {
    case "Ready":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "Failed":
      return "bg-destructive/10 text-destructive";
    case "Starting":
    case "Stopping":
    case "Deleting":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "Stopped":
      return "bg-muted text-muted-foreground";
  }
};

export function HostedDashboard() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "T3 Code K8s";
    return () => {
      document.title = previousTitle;
    };
  }, []);

  const [identity, setIdentity] = useState<IdentitySummary>();
  const [organizationId, setOrganizationId] = useState<OrganizationId>();
  const [workspaces, setWorkspaces] = useState<ReadonlyArray<WorkspaceSummary>>([]);
  const [storage, setStorage] = useState<StorageOptions>();
  const [section, setSection] = useState<Section>("overview");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyWorkspaceId, setBusyWorkspaceId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteWorkspace, setDeleteWorkspace] = useState<WorkspaceSummary>();
  const [migrationWorkspace, setMigrationWorkspace] = useState<WorkspaceSummary>();
  const [error, setError] = useState<string>();

  const organization = identity?.organizations.find((item) => item.id === organizationId);

  const loadIdentity = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const nextIdentity = await client.me();
      setIdentity(nextIdentity);
      setOrganizationId((current) => current ?? nextIdentity.organizations[0]?.id);
    } catch (cause) {
      if (!(cause instanceof HostedControlPlaneError && cause.status === 401)) {
        setError(messageFor(cause, "Unable to load your hosted account."));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const loadOrganization = useCallback(
    async (showSpinner = false) => {
      if (organizationId === undefined) return;
      if (showSpinner) setRefreshing(true);
      setError(undefined);
      try {
        const [nextWorkspaces, nextStorage] = await Promise.all([
          client.listWorkspaces(organizationId),
          client.storageOptions(organizationId),
        ]);
        setWorkspaces(nextWorkspaces);
        setStorage(nextStorage);
      } catch (cause) {
        setError(messageFor(cause, "Unable to load organization data."));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [organizationId],
  );

  useEffect(() => void loadIdentity(), [loadIdentity]);
  useEffect(() => void loadOrganization(), [loadOrganization]);

  const setDesiredState = async (workspace: WorkspaceSummary) => {
    if (organizationId === undefined) return;
    setBusyWorkspaceId(workspace.id);
    setError(undefined);
    try {
      await client.setDesiredState(organizationId, workspace.id, {
        desiredState: workspace.desiredState === "Running" ? "Stopped" : "Running",
        expectedGeneration: workspace.generation,
      });
      await loadOrganization();
    } catch (cause) {
      setError(messageFor(cause, "Unable to update workspace."));
    } finally {
      setBusyWorkspaceId(undefined);
    }
  };

  const applyImageMigration = async (workspace: WorkspaceSummary) => {
    if (organizationId === undefined) return;
    setBusyWorkspaceId(workspace.id);
    setError(undefined);
    try {
      await client.migrateImage(organizationId, workspace.id, {
        expectedGeneration: workspace.generation,
      });
      await loadOrganization();
    } catch (cause) {
      setError(messageFor(cause, "Unable to migrate workspace image."));
    } finally {
      setBusyWorkspaceId(undefined);
      setMigrationWorkspace(undefined);
    }
  };

  const openWorkspace = async (workspace: WorkspaceSummary, target: "t3" | "code") => {
    if (organizationId === undefined) return;
    const workspaceTab = window.open("about:blank", "_blank");
    if (workspaceTab === null) {
      setError("Allow pop-ups for this site to open workspaces in a new tab.");
      return;
    }
    workspaceTab.opener = null;
    setBusyWorkspaceId(workspace.id);
    setError(undefined);
    try {
      const session = await client.createProxySession(organizationId, workspace.id);
      workspaceTab.location.replace(target === "t3" ? session.t3Url : session.codeServerUrl);
    } catch (cause) {
      workspaceTab.close();
      setError(messageFor(cause, "Unable to open workspace."));
    } finally {
      setBusyWorkspaceId(undefined);
    }
  };

  const confirmDeleteWorkspace = async (
    workspace: WorkspaceSummary,
    volumePolicy: "retain" | "delete",
  ) => {
    if (organizationId === undefined) return;
    setBusyWorkspaceId(workspace.id);
    setError(undefined);
    try {
      await client.deleteWorkspace(organizationId, workspace.id, {
        volumePolicy,
        expectedGeneration: workspace.generation,
      });
      await loadOrganization();
    } catch (cause) {
      setError(messageFor(cause, "Unable to delete workspace."));
    } finally {
      setBusyWorkspaceId(undefined);
      setDeleteWorkspace(undefined);
    }
  };

  const logout = async () => {
    await client.logout();
    window.location.assign("/");
  };

  if (!loading && identity === undefined && error === undefined) return <SignIn />;

  return (
    <SidebarProvider className="h-dvh! min-h-0!" defaultOpen>
      <HostedSidebar
        identity={identity}
        organizationId={organizationId}
        section={section}
        onOrganizationChange={setOrganizationId}
        onSectionChange={setSection}
        onLogout={() => void logout()}
      />

      <SidebarInset className="min-w-0 bg-background">
        <header
          className={cn(
            "workspace-topbar sticky top-0 z-20 flex items-center gap-3 border-b bg-background/90 px-3 backdrop-blur transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex-1" />
          {section === "workspaces" ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={() => void loadOrganization(true)}
              >
                <RefreshCw className={refreshing ? "animate-spin" : undefined} />{" "}
                <span className="hidden sm:inline">Refresh</span>
              </Button>
              {organization !== undefined && roleCanAdminister(organization.role) ? (
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus /> New workspace
                </Button>
              ) : null}
            </>
          ) : null}
        </header>

        <SettingsPageContainer>
          {error !== undefined ? (
            <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <span className="capitalize">{error}</span>
              <button type="button" onClick={() => setError(undefined)}>
                <X className="size-4" />
              </button>
            </div>
          ) : null}
          {loading && identity === undefined ? <LoadingState /> : null}
          {identity !== undefined && organization === undefined ? (
            <EmptyState
              title="No organization access"
              description="Ask an administrator for an invitation."
            />
          ) : null}
          {organization !== undefined && section === "overview" ? (
            <Overview
              organization={organization}
              workspaces={workspaces}
              storage={storage}
              onNavigate={setSection}
            />
          ) : null}
          {organization !== undefined && section === "workspaces" ? (
            <WorkspacesSection
              organization={organization}
              workspaces={workspaces}
              imageProfiles={storage?.imageProfiles ?? []}
              loading={loading}
              busyWorkspaceId={busyWorkspaceId}
              onCreate={() => setCreateOpen(true)}
              onDesiredState={setDesiredState}
              onMigrate={setMigrationWorkspace}
              onOpen={openWorkspace}
              onDelete={setDeleteWorkspace}
            />
          ) : null}
          {organization !== undefined && section === "storage" ? (
            <StorageSection storage={storage} />
          ) : null}
          {organization !== undefined && section === "team" ? (
            <TeamSection organization={organization} organizationId={organizationId!} />
          ) : null}
          {organization !== undefined && section === "organization" ? (
            <OrganizationSection
              organization={organization}
              onRenamed={async () => {
                await loadIdentity();
                await loadOrganization();
              }}
            />
          ) : null}
        </SettingsPageContainer>
      </SidebarInset>

      {migrationWorkspace !== undefined ? (
        <MigrateWorkspaceDialog
          workspace={migrationWorkspace}
          busy={busyWorkspaceId === migrationWorkspace.id}
          onClose={() => setMigrationWorkspace(undefined)}
          onConfirm={() => void applyImageMigration(migrationWorkspace)}
        />
      ) : null}
      {deleteWorkspace !== undefined ? (
        <DeleteWorkspaceDialog
          workspace={deleteWorkspace}
          busy={busyWorkspaceId === deleteWorkspace.id}
          onClose={() => setDeleteWorkspace(undefined)}
          onConfirm={(volumePolicy) => void confirmDeleteWorkspace(deleteWorkspace, volumePolicy)}
        />
      ) : null}
      {createOpen && organizationId !== undefined && storage !== undefined ? (
        <CreateWorkspacePanel
          organizationId={organizationId}
          storage={storage}
          onClose={() => setCreateOpen(false)}
          onCreated={async () => {
            setCreateOpen(false);
            await loadOrganization();
          }}
          onError={(cause) => setError(messageFor(cause, "Unable to create workspace."))}
        />
      ) : null}
    </SidebarProvider>
  );
}

function HostedSidebar({
  identity,
  organizationId,
  section,
  onOrganizationChange,
  onSectionChange,
  onLogout,
}: {
  readonly identity: IdentitySummary | undefined;
  readonly organizationId: OrganizationId | undefined;
  readonly section: Section;
  readonly onOrganizationChange: (organizationId: OrganizationId) => void;
  readonly onSectionChange: (section: Section) => void;
  readonly onLogout: () => void;
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const selectSection = (nextSection: Section) => {
    onSectionChange(nextSection);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      data-app-sidebar=""
      className="border-r border-sidebar-border bg-sidebar text-sidebar-foreground"
    >
      <SidebarHeader className="h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center px-3 py-0">
        <SidebarTrigger className="shrink-0" />
        <a
          href="/"
          aria-label="T3 Code K8s dashboard"
          className="sidebar-brand flex h-7 min-w-0 items-center gap-1 rounded-md outline-hidden ring-ring focus-visible:ring-2"
        >
          <T3Wordmark />
          <span className="truncate text-sm font-medium tracking-tight text-muted-foreground">
            Code
          </span>
          <Badge className="ml-1 rounded-full px-1.5" size="sm" variant="secondary">
            K8s
          </Badge>
        </a>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="pb-1">
          <label className="relative block">
            <select
              aria-label="Organization"
              className="h-9 w-full appearance-none rounded-lg border border-sidebar-border bg-sidebar-accent px-3 pr-8 text-sm font-medium outline-hidden ring-ring focus-visible:ring-2"
              value={organizationId ?? ""}
              onChange={(event) => onOrganizationChange(event.target.value as OrganizationId)}
            >
              {identity?.organizations.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 size-4 text-sidebar-muted-foreground" />
          </label>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarMenu>
            {navigation.map((item) => {
              const Icon = item.icon;
              return (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={section === item.id}
                    tooltip={item.label}
                    onClick={() => selectSection(item.id)}
                  >
                    <Icon />
                    <span>{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-[var(--sidebar-content-inset)]">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="h-auto py-2" tooltip="Account">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-sidebar-accent text-xs font-semibold">
                {identity?.principal.displayName.slice(0, 1).toUpperCase() ?? "?"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {identity?.principal.displayName}
                </span>
                <span className="block truncate text-xs text-sidebar-muted-foreground">
                  {identity?.principal.email}
                </span>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onLogout} tooltip="Sign out">
              <LogOut />
              <span>Sign out</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function SignIn() {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
      <section className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-foreground text-background">
          <Boxes />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">T3 Code K8s</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Sign in to manage and open your organization’s coding workspaces.
        </p>
        <Button className="mt-7 w-full" render={<a href="/auth/login?return_to=%2F" />}>
          <LogIn /> Sign in with SSO
        </Button>
      </section>
    </main>
  );
}

function LoadingState() {
  return (
    <div className="grid min-h-96 place-items-center text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin" /> Loading dashboard
      </span>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed p-12 text-center">
      <h2 className="font-medium">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Overview({
  organization,
  workspaces,
  storage,
  onNavigate,
}: {
  readonly organization: OrganizationSummary;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly storage: StorageOptions | undefined;
  readonly onNavigate: (section: Section) => void;
}) {
  const ready = workspaces.filter((item) => item.phase === "Ready").length;
  const running = workspaces.filter((item) => item.desiredState === "Running").length;
  return (
    <div className="space-y-8">
      <HostedPageHeading
        title={`Welcome to ${organization.name}`}
        description="Manage your coding environments, storage, and team access."
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total workspaces" value={workspaces.length} icon={Boxes} />
        <Metric label="Running" value={running} icon={Play} />
        <Metric label="Ready" value={ready} icon={LayoutDashboard} />
        <Metric
          label="Available volumes"
          value={storage?.existingVolumes.filter((item) => item.status === "available").length ?? 0}
          icon={Database}
        />
      </div>
      <Card render={<section />}>
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h3 className="font-medium">Recent workspaces</h3>
            <p className="text-xs text-muted-foreground">Current organization activity</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("workspaces")}>
            View all
          </Button>
        </div>
        <div className="divide-y">
          {workspaces.slice(0, 5).map((workspace) => (
            <div key={workspace.id} className="flex items-center gap-4 px-5 py-4">
              <div className="grid size-9 place-items-center rounded-xl bg-muted">
                <Boxes className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{workspace.name}</div>
                <div className="text-xs text-muted-foreground">{workspace.imageProfile}</div>
              </div>
              <PhaseBadge phase={workspace.phase} />
            </div>
          ))}
          {workspaces.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">No workspaces yet.</div>
          ) : null}
        </div>
      </Card>
    </div>
  );
}

function Metric({
  label,
  value,
  icon: Icon,
}: {
  readonly label: string;
  readonly value: number;
  readonly icon: typeof Boxes;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{label}</span>
        <Icon className="size-4" />
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-[-0.035em]">{value}</div>
    </Card>
  );
}

function HostedPageHeading({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="space-y-1 px-1 sm:px-2">
      <h2 className="text-lg font-semibold tracking-[-0.025em] text-foreground">{title}</h2>
      <p className="max-w-2xl text-[13px] leading-[1.45] text-muted-foreground/80">{description}</p>
    </div>
  );
}

function PhaseBadge({ phase }: { readonly phase: WorkspaceSummary["phase"] }) {
  return <Badge className={cn("border-0 font-medium", phaseTone(phase))}>{phase}</Badge>;
}

function WorkspacesSection({
  organization,
  workspaces,
  imageProfiles,
  loading,
  busyWorkspaceId,
  onCreate,
  onDesiredState,
  onMigrate,
  onOpen,
  onDelete,
}: {
  readonly organization: OrganizationSummary;
  readonly workspaces: ReadonlyArray<WorkspaceSummary>;
  readonly imageProfiles: ReadonlyArray<{ readonly id: string; readonly revision: string }>;
  readonly loading: boolean;
  readonly busyWorkspaceId: string | undefined;
  readonly onCreate: () => void;
  readonly onDesiredState: (workspace: WorkspaceSummary) => void;
  readonly onMigrate: (workspace: WorkspaceSummary) => void;
  readonly onOpen: (workspace: WorkspaceSummary, target: "t3" | "code") => void;
  readonly onDelete: (workspace: WorkspaceSummary) => void;
}) {
  const [expandedWorkspaceId, setExpandedWorkspaceId] = useState<string>();
  if (loading && workspaces.length === 0) return <LoadingState />;
  if (workspaces.length === 0)
    return (
      <EmptyState
        title="No workspaces yet"
        description="Create an isolated T3 Code and VS Code environment."
      />
    );
  return (
    <SettingsSection title="Workspaces" icon={<Boxes className="size-4" />}>
      {workspaces.map((workspace) => {
        const busy = busyWorkspaceId === workspace.id;
        const ready = workspace.phase === "Ready";
        const expanded = expandedWorkspaceId === workspace.id;
        const deployedRevision = imageProfiles.find(
          (profile) => profile.id === workspace.imageProfile,
        )?.revision;
        const migrationAvailable =
          deployedRevision !== undefined && deployedRevision !== workspace.imageRevision;
        return (
          <SettingsRow
            key={workspace.id}
            title={
              <span className="inline-flex items-center gap-2">
                {workspace.name}
                <PhaseBadge phase={workspace.phase} />
              </span>
            }
            description={`${workspace.slug} · ${workspace.imageProfile} · generation ${workspace.generation}/${workspace.observedGeneration}`}
            status={
              workspace.failureMessage ? (
                <span className="text-destructive">{workspace.failureMessage}</span>
              ) : undefined
            }
            control={
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setExpandedWorkspaceId(expanded ? undefined : workspace.id)}
                >
                  {expanded ? "Hide details" : "Details"}
                </Button>
                {migrationAvailable ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => onMigrate(workspace)}
                  >
                    <RefreshCw /> Migrate
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => onDesiredState(workspace)}
                >
                  {workspace.desiredState === "Running" ? <Square /> : <Play />}
                  {workspace.desiredState === "Running" ? "Stop" : "Start"}
                </Button>
                <Button size="xs" disabled={!ready || busy} onClick={() => onOpen(workspace, "t3")}>
                  <ExternalLink /> T3
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!ready || busy}
                  onClick={() => onOpen(workspace, "code")}
                >
                  <ExternalLink /> VS Code
                </Button>
                {roleCanAdminister(organization.role) ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    disabled={busy}
                    title="Delete workspace"
                    onClick={() => onDelete(workspace)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </div>
            }
          >
            {expanded ? <WorkspaceDetails workspace={workspace} /> : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

function WorkspaceDetails({ workspace }: { readonly workspace: WorkspaceSummary }) {
  const rows = [
    ["Workspace ID", workspace.id],
    ["Desired state", workspace.desiredState],
    ["Target node", workspace.nodeName],
    ["Environment ID", workspace.environmentId ?? "Not assigned"],
    ["Route host", workspace.routeHost ?? "Not assigned"],
    ["Image profile", `${workspace.imageProfile} · ${workspace.imageRevision}`],
    ["Failure reason", workspace.failureReason ?? "None"],
  ] as const;
  return (
    <dl className="mt-3 grid gap-x-8 gap-y-3 border-t px-1 py-4 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
          <dd className="mt-0.5 truncate text-xs text-foreground" title={value}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function StorageSection({ storage }: { readonly storage: StorageOptions | undefined }) {
  return (
    <div className="w-full space-y-10">
      <SettingsSection title="Storage classes" icon={<HardDrive className="size-4" />}>
        {storage?.storageClasses.map((item) => (
          <SettingsRow
            key={item.name}
            title={item.name}
            description={`${item.bindingMode} · ${item.allowedAccessModes.join(", ")} · ${Math.round(item.minimumBytes / gibibyte)}–${Math.round(item.maximumBytes / gibibyte)} GiB`}
            status={item.allowExpansion ? "Volume expansion supported" : "Fixed-size volumes"}
            control={
              item.isDefault ? <Badge>Default</Badge> : <Badge variant="outline">Available</Badge>
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Existing volumes" icon={<Database className="size-4" />}>
        {storage?.existingVolumes.length ? (
          storage.existingVolumes.map((item) => (
            <SettingsRow
              key={item.id}
              title={item.id}
              description={`${item.storageClass} · ${Math.round(item.capacityBytes / gibibyte)} GiB · ${item.accessMode}`}
              control={<Badge variant="outline">{item.status}</Badge>}
            />
          ))
        ) : (
          <SettingsRow
            title="No reusable volumes"
            description="Retained workspace volumes will appear here when available."
          />
        )}
      </SettingsSection>
    </div>
  );
}

function TeamSection({
  organization,
  organizationId,
}: {
  readonly organization: OrganizationSummary;
  readonly organizationId: OrganizationId;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "viewer">("member");
  const [busy, setBusy] = useState(false);
  const [inviteLink, setInviteLink] = useState<string>();
  const [members, setMembers] = useState<ReadonlyArray<OrganizationMember>>([]);
  const [error, setError] = useState<string>();
  const loadMembers = useCallback(async () => {
    try {
      setMembers(await client.listMembers(organizationId));
    } catch (cause) {
      setError(messageFor(cause, "Unable to load members."));
    }
  }, [organizationId]);
  useEffect(() => void loadMembers(), [loadMembers]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setInviteLink(undefined);
    try {
      const invitation = await client.createInvitation(organizationId, {
        email,
        role,
        expiresInSeconds: 604800,
      });
      setInviteLink(
        `${window.location.origin}/auth/login?invitation_token=${encodeURIComponent(invitation.token)}&return_to=%2F`,
      );
      setEmail("");
    } catch (cause) {
      setError(messageFor(cause, "Unable to create invitation."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-10">
      {roleCanAdminister(organization.role) ? (
        <SettingsSection title="Invitations" icon={<MailPlus className="size-4" />}>
          <SettingsRow
            title="Invite a teammate"
            description="Invitation links expire after seven days and can only enroll the specified email."
          >
            <form
              className="mt-6 grid gap-4 sm:grid-cols-[1fr_9rem_auto]"
              onSubmit={(event) => void submit(event)}
            >
              <Input
                type="email"
                required
                placeholder="name@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
              <select
                className="h-9 rounded-lg border bg-background px-3 text-sm"
                value={role}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="admin">Admin</option>
                <option value="member">Member</option>
                <option value="viewer">Viewer</option>
              </select>
              <Button type="submit" disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <MailPlus />} Invite
              </Button>
            </form>
            {error ? <p className="mt-3 text-sm text-destructive">{error}</p> : null}
            {inviteLink ? (
              <div className="mt-5 rounded-xl border bg-muted/40 p-4">
                <p className="text-xs font-medium">Invitation created — copy this link now</p>
                <div className="mt-2 flex gap-2">
                  <Input
                    readOnly
                    value={inviteLink}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void navigator.clipboard.writeText(inviteLink)}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            ) : null}
          </SettingsRow>
        </SettingsSection>
      ) : (
        <EmptyState
          title="Member access"
          description="Only organization owners and administrators can create invitations."
        />
      )}
      <SettingsSection title="Members" icon={<Users className="size-4" />}>
        {members.map((member) => (
          <SettingsRow
            key={member.principalId}
            title={member.displayName}
            description={member.email}
            status={member.status === "active" ? undefined : member.status}
            control={
              roleCanAdminister(organization.role) && member.role !== "owner" ? (
                <select
                  aria-label={`${member.displayName} role`}
                  className="h-8 rounded-lg border bg-background px-2 text-xs"
                  value={member.role}
                  onChange={(event) =>
                    void client
                      .updateMemberRole(organizationId, member.principalId, {
                        role: event.target.value as "admin" | "member" | "viewer",
                      })
                      .then(loadMembers)
                      .catch((cause) => setError(messageFor(cause, "Unable to update member.")))
                  }
                >
                  <option value="admin">Admin</option>
                  <option value="member">Member</option>
                  <option value="viewer">Viewer</option>
                </select>
              ) : (
                <Badge variant="outline" className="capitalize">
                  {member.role}
                </Badge>
              )
            }
          />
        ))}
        {members.length === 0 ? (
          <SettingsRow title="No members" description="Invite teammates to build together." />
        ) : null}
      </SettingsSection>
    </div>
  );
}

function OrganizationSection({
  organization,
  onRenamed,
}: {
  readonly organization: OrganizationSummary;
  readonly onRenamed: () => Promise<void>;
}) {
  const [name, setName] = useState(organization.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const rename = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await client.renameOrganization(organization.id, { name });
      await onRenamed();
    } catch (cause) {
      setError(messageFor(cause, "Unable to rename organization."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-10">
      <SettingsSection title="Organization" icon={<Building2 className="size-4" />}>
        <SettingsRow
          title="Name"
          description="The organization name shown throughout the hosted dashboard."
          status={error ? <span className="text-destructive">{error}</span> : undefined}
          control={
            roleCanAdminister(organization.role) ? (
              <div className="flex items-center gap-2">
                <Input
                  className="w-56"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || !name.trim() || name.trim() === organization.name}
                  onClick={() => void rename()}
                >
                  {busy ? <LoaderCircle className="animate-spin" /> : null} Save
                </Button>
              </div>
            ) : (
              <span className="text-sm font-medium">{organization.name}</span>
            )
          }
        />
        <SettingsRow
          title="Slug"
          description="The stable human-readable organization identifier."
          control={<code className="text-xs text-muted-foreground">{organization.slug}</code>}
        />
        <SettingsRow
          title="Organization ID"
          description="The immutable identifier used by the control plane."
          control={
            <code className="max-w-72 truncate text-xs text-muted-foreground">
              {organization.id}
            </code>
          }
        />
        <SettingsRow
          title="Your role"
          description="Your current permissions in this organization."
          control={
            <Badge variant="outline" className="capitalize">
              {organization.role}
            </Badge>
          }
        />
      </SettingsSection>
    </div>
  );
}

function MigrateWorkspaceDialog({
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  readonly workspace: WorkspaceSummary;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Migrate {workspace.name}?</DialogTitle>
          <DialogDescription>
            Update to the deployed {workspace.imageProfile} image revision.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <p className="text-sm text-muted-foreground">
            A running workspace restarts. Active T3 Code and VS Code sessions disconnect.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} Migrate workspace
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DeleteWorkspaceDialog({
  workspace,
  busy,
  onClose,
  onConfirm,
}: {
  readonly workspace: WorkspaceSummary;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onConfirm: (volumePolicy: "retain" | "delete") => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {workspace.name}?</DialogTitle>
          <DialogDescription>
            Choose whether to retain its persistent volume for a later workspace.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Deleting the workspace stops its environment and removes its route. This cannot be
            undone.
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => onConfirm("retain")}>
            Retain volume
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => onConfirm("delete")}>
            {busy ? <LoaderCircle className="animate-spin" /> : <Trash2 />} Delete volume
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function CreateWorkspacePanel({
  organizationId,
  storage,
  onClose,
  onCreated,
  onError,
}: {
  readonly organizationId: OrganizationId;
  readonly storage: StorageOptions;
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
  readonly onError: (cause: unknown) => void;
}) {
  const defaultClass =
    storage.storageClasses.find((item) => item.isDefault) ?? storage.storageClasses[0];
  const [name, setName] = useState("");
  const [nodeName, setNodeName] = useState(storage.nodes[0] ?? "");
  const [storageKind, setStorageKind] = useState<"new" | "existing">("new");
  const [storageClass, setStorageClass] = useState(defaultClass?.name ?? "");
  const [volumeId, setVolumeId] = useState(
    storage.existingVolumes.find((item) => item.status === "available")?.id ?? "",
  );
  const [sizeGiB, setSizeGiB] = useState(20);
  const [retentionPolicy, setRetentionPolicy] = useState<"retain" | "delete">("retain");
  const [cpuLimit, setCpuLimit] = useState(2000);
  const [memoryGiB, setMemoryGiB] = useState(4);
  const [busy, setBusy] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const input: CreateWorkspaceRequest = {
      name,
      nodeName,
      imageProfile: "stable",
      egressProfile: "internet",
      resources: {
        cpuRequestMillis: Math.min(250, cpuLimit),
        cpuLimitMillis: cpuLimit,
        memoryRequestBytes: Math.min(gibibyte, memoryGiB * gibibyte),
        memoryLimitBytes: memoryGiB * gibibyte,
        ephemeralStorageBytes: 2 * gibibyte,
      },
      storage:
        storageKind === "new"
          ? {
              kind: "new",
              storageClass,
              requestedBytes: sizeGiB * gibibyte,
              accessMode: "ReadWriteOnce",
              retentionPolicy,
            }
          : {
              kind: "existing",
              volumeId: volumeId as CreateWorkspaceRequest["storage"] extends {
                kind: "existing";
                volumeId: infer I;
              }
                ? I
                : never,
            },
    };
    try {
      await client.createWorkspace(organizationId, input);
      await onCreated();
    } catch (cause) {
      onError(cause);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Create workspace</DialogTitle>
          <DialogDescription>
            Provision T3 Code and VS Code with persistent storage.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[65vh] space-y-7" scrollFade={false}>
          <form className="space-y-7" onSubmit={(event) => void submit(event)}>
            <Field label="Workspace name" description="A friendly name shown to your team.">
              <Input
                required
                autoFocus
                placeholder="My workspace"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="CPU limit" description="Millicores">
                <Input
                  type="number"
                  min={250}
                  max={16000}
                  step={250}
                  value={cpuLimit}
                  onChange={(event) => setCpuLimit(Number(event.target.value))}
                />
              </Field>
              <Field label="Memory limit" description="GiB">
                <Input
                  type="number"
                  min={1}
                  max={64}
                  value={memoryGiB}
                  onChange={(event) => setMemoryGiB(Number(event.target.value))}
                />
              </Field>
            </div>
            <Field label="Target node" description="Kubernetes node for this workspace.">
              <HostedSelect
                ariaLabel="Target node"
                value={nodeName}
                onValueChange={setNodeName}
                options={storage.nodes.map((node) => ({ value: node, label: node }))}
              />
            </Field>
            <Field
              label="Storage source"
              description="Create a volume or attach an available retained volume."
            >
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={storageKind === "new" ? "default" : "outline"}
                  onClick={() => setStorageKind("new")}
                >
                  <HardDrive /> New volume
                </Button>
                <Button
                  type="button"
                  variant={storageKind === "existing" ? "default" : "outline"}
                  disabled={!storage.existingVolumes.some((item) => item.status === "available")}
                  onClick={() => setStorageKind("existing")}
                >
                  <Database /> Existing
                </Button>
              </div>
            </Field>
            {storageKind === "new" ? (
              <>
                <Field label="Storage class">
                  <HostedSelect
                    ariaLabel="Storage class"
                    value={storageClass}
                    onValueChange={setStorageClass}
                    options={storage.storageClasses.map((item) => ({
                      value: item.name,
                      label: `${item.name}${item.isDefault ? " (default)" : ""}`,
                    }))}
                  />
                </Field>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Volume size" description="GiB">
                    <Input
                      type="number"
                      min={1}
                      max={1024}
                      value={sizeGiB}
                      onChange={(event) => setSizeGiB(Number(event.target.value))}
                    />
                  </Field>
                  <Field label="On workspace deletion">
                    <HostedSelect
                      ariaLabel="Storage retention policy"
                      value={retentionPolicy}
                      onValueChange={(value) => setRetentionPolicy(value as typeof retentionPolicy)}
                      options={[
                        { value: "retain", label: "Retain volume" },
                        { value: "delete", label: "Delete volume" },
                      ]}
                    />
                  </Field>
                </div>
              </>
            ) : (
              <Field label="Existing volume">
                <HostedSelect
                  ariaLabel="Existing volume"
                  value={volumeId}
                  onValueChange={setVolumeId}
                  options={storage.existingVolumes
                    .filter((item) => item.status === "available")
                    .map((item) => ({
                      value: item.id,
                      label: `${item.id} · ${Math.round(item.capacityBytes / gibibyte)} GiB`,
                    }))}
                />
              </Field>
            )}
            <div className="rounded-xl bg-muted/50 p-4 text-xs text-muted-foreground">
              <strong className="text-foreground">Runtime profile:</strong> stable image · internet
              egress egress · ReadWriteOnce storage
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  busy || !name.trim() || (storageKind === "new" ? !storageClass : !volumeId)
                }
              >
                {busy ? <LoaderCircle className="animate-spin" /> : <Plus />} Create workspace
              </Button>
            </DialogFooter>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function HostedSelect({
  value,
  onValueChange,
  options,
  ariaLabel,
  disabled,
}: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}) {
  return (
    <Select
      modal={false}
      value={value}
      items={options}
      disabled={disabled}
      onValueChange={(next) => next !== null && onValueChange(next)}
    >
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
}

function Field({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      {description ? (
        <span className="ml-2 text-xs text-muted-foreground">{description}</span>
      ) : null}
      <div className="mt-2">{children}</div>
    </label>
  );
}
