ALTER TABLE outbox_events
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by text,
  ADD COLUMN last_error text,
  ADD CONSTRAINT outbox_lock_pair_check CHECK (
    (locked_at IS NULL AND locked_by IS NULL) OR
    (locked_at IS NOT NULL AND btrim(locked_by) <> '')
  );

DROP INDEX outbox_events_pending_idx;
CREATE INDEX outbox_events_pending_idx
  ON outbox_events(next_attempt_at, id)
  WHERE published_at IS NULL;

CREATE FUNCTION notify_t3_outbox_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('t3_control_plane_outbox', 'pending');
  RETURN NEW;
END;
$$;

CREATE TRIGGER outbox_events_notify
AFTER INSERT ON outbox_events
FOR EACH STATEMENT EXECUTE FUNCTION notify_t3_outbox_event();
