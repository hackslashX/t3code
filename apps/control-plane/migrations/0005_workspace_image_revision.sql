ALTER TABLE workspaces
  ADD COLUMN image_revision text NOT NULL DEFAULT 'legacy' CHECK (btrim(image_revision) <> '');
