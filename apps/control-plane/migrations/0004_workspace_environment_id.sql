UPDATE workspaces
SET environment_id = gen_random_uuid()::text
WHERE environment_id IS NULL;

ALTER TABLE workspaces
  ALTER COLUMN environment_id SET NOT NULL,
  ADD CONSTRAINT workspaces_environment_id_nonempty CHECK (btrim(environment_id) <> '');
