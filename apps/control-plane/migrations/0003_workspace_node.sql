ALTER TABLE workspaces ADD COLUMN node_name text;

UPDATE workspaces AS workspaces
SET node_name = CASE
  WHEN volumes.storage_class IN ('longhorn-ssd-atlas', 'longhorn-hdd-atlas') THEN 'atlas'
  ELSE 'orion'
END
FROM workspace_volumes AS volumes
WHERE volumes.id = workspaces.volume_id;

ALTER TABLE workspaces
  ALTER COLUMN node_name SET NOT NULL,
  ADD CONSTRAINT workspaces_node_name_nonempty CHECK (btrim(node_name) <> '');
