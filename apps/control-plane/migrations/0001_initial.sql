CREATE TABLE principals (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  email text NOT NULL CHECK (btrim(email) <> ''),
  avatar_url text,
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE external_identities (
  id uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  issuer text NOT NULL CHECK (btrim(issuer) <> ''),
  subject text NOT NULL CHECK (btrim(subject) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
CREATE INDEX external_identities_principal_idx ON external_identities(principal_id);

CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text NOT NULL CHECK (status IN ('active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_memberships (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status text NOT NULL CHECK (status IN ('invited', 'active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, principal_id)
);
CREATE INDEX organization_memberships_principal_idx
  ON organization_memberships(principal_id, status);

CREATE TABLE organization_invitations (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (btrim(email) <> ''),
  role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  token_hash bytea NOT NULL UNIQUE,
  invited_by_principal_id uuid NOT NULL REFERENCES principals(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);
CREATE INDEX organization_invitations_lookup_idx
  ON organization_invitations(organization_id, lower(email), expires_at)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE organization_quotas (
  organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  max_workspaces integer NOT NULL CHECK (max_workspaces > 0),
  max_running_workspaces integer NOT NULL CHECK (
    max_running_workspaces > 0 AND max_running_workspaces <= max_workspaces
  ),
  max_cpu_millis bigint NOT NULL CHECK (max_cpu_millis > 0),
  max_memory_bytes bigint NOT NULL CHECK (max_memory_bytes > 0),
  max_storage_bytes bigint NOT NULL CHECK (max_storage_bytes > 0),
  max_gpu_by_class jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(max_gpu_by_class) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_volumes (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  kubernetes_pvc_uid text UNIQUE CHECK (
    kubernetes_pvc_uid IS NULL OR btrim(kubernetes_pvc_uid) <> ''
  ),
  kubernetes_pvc_name text NOT NULL CHECK (btrim(kubernetes_pvc_name) <> ''),
  storage_class text NOT NULL CHECK (btrim(storage_class) <> ''),
  capacity_bytes bigint NOT NULL CHECK (capacity_bytes > 0),
  access_mode text NOT NULL CHECK (access_mode IN ('ReadWriteOnce', 'ReadWriteMany')),
  source text NOT NULL CHECK (source IN ('created', 'imported')),
  status text NOT NULL CHECK (status IN ('provisioning', 'available', 'attached', 'deleting', 'failed')),
  retention_policy text NOT NULL CHECK (retention_policy IN ('retain', 'delete')),
  attached_workspace_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'provisioning' OR kubernetes_pvc_uid IS NOT NULL),
  UNIQUE (organization_id, kubernetes_pvc_name),
  UNIQUE (id, organization_id)
);
CREATE INDEX workspace_volumes_available_idx
  ON workspace_volumes(organization_id, status)
  WHERE status = 'available';

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  owner_principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (btrim(name) <> ''),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  desired_state text NOT NULL CHECK (desired_state IN ('Running', 'Stopped')),
  phase text NOT NULL CHECK (phase IN ('Starting', 'Ready', 'Stopping', 'Stopped', 'Failed', 'Deleting')),
  generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
  observed_generation bigint NOT NULL DEFAULT 0 CHECK (
    observed_generation >= 0 AND observed_generation <= generation
  ),
  image_profile text NOT NULL CHECK (btrim(image_profile) <> ''),
  cpu_request_millis bigint NOT NULL CHECK (cpu_request_millis > 0),
  cpu_limit_millis bigint NOT NULL CHECK (cpu_limit_millis >= cpu_request_millis),
  memory_request_bytes bigint NOT NULL CHECK (memory_request_bytes > 0),
  memory_limit_bytes bigint NOT NULL CHECK (memory_limit_bytes >= memory_request_bytes),
  ephemeral_storage_bytes bigint NOT NULL CHECK (ephemeral_storage_bytes > 0),
  gpu_class text,
  gpu_count integer,
  egress_profile text NOT NULL CHECK (btrim(egress_profile) <> ''),
  volume_id uuid NOT NULL,
  route_host text,
  environment_id text,
  failure_reason text,
  failure_message text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((gpu_class IS NULL AND gpu_count IS NULL) OR
         (btrim(gpu_class) <> '' AND gpu_count > 0)),
  UNIQUE (organization_id, slug),
  FOREIGN KEY (volume_id, organization_id)
    REFERENCES workspace_volumes(id, organization_id) ON DELETE RESTRICT
);
ALTER TABLE workspace_volumes
  ADD CONSTRAINT workspace_volumes_attached_workspace_fk
  FOREIGN KEY (attached_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX workspace_volumes_single_attachment_idx
  ON workspace_volumes(attached_workspace_id)
  WHERE attached_workspace_id IS NOT NULL;
CREATE INDEX workspaces_org_active_idx
  ON workspaces(organization_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX workspaces_desired_state_idx
  ON workspaces(desired_state, generation)
  WHERE deleted_at IS NULL;

CREATE TABLE workspace_conditions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('StorageReady', 'Scheduled', 'PodReady', 'RouteReady', 'Authenticated')),
  status text NOT NULL CHECK (status IN ('True', 'False', 'Unknown')),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  message text NOT NULL,
  observed_generation bigint NOT NULL CHECK (observed_generation >= 0),
  last_transition_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, type)
);

CREATE TABLE web_sessions (
  id_hash bytea PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  oidc_session_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX web_sessions_principal_active_idx
  ON web_sessions(principal_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  request_id text NOT NULL CHECK (btrim(request_id) <> ''),
  actor_principal_id uuid REFERENCES principals(id) ON DELETE SET NULL,
  organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (btrim(action) <> ''),
  resource_type text NOT NULL CHECK (btrim(resource_type) <> ''),
  resource_id text,
  result text NOT NULL CHECK (result IN ('allowed', 'denied', 'failed')),
  source_ip inet,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object')
);
CREATE INDEX audit_events_org_time_idx ON audit_events(organization_id, occurred_at DESC);
CREATE INDEX audit_events_actor_time_idx ON audit_events(actor_principal_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL CHECK (btrim(aggregate_type) <> ''),
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_events_pending_idx ON outbox_events(id) WHERE published_at IS NULL;
