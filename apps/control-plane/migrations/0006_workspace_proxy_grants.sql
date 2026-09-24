CREATE TABLE workspace_proxy_grants (
  id uuid PRIMARY KEY,
  credential_hash bytea NOT NULL UNIQUE,
  browser_session_hash bytea NOT NULL REFERENCES web_sessions(id_hash) ON DELETE CASCADE,
  principal_id uuid NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);
CREATE INDEX workspace_proxy_grants_browser_session_active_idx
  ON workspace_proxy_grants(browser_session_hash, expires_at)
  WHERE revoked_at IS NULL;
