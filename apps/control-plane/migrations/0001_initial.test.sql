BEGIN;

INSERT INTO principals (id, display_name, email, status)
VALUES ('00000000-0000-0000-0000-000000000001', 'Test User', 'test@example.test', 'active');
INSERT INTO organizations (id, slug, name, status)
VALUES
  ('00000000-0000-0000-0000-000000000010', 'organization-a', 'Organization A', 'active'),
  ('00000000-0000-0000-0000-000000000020', 'organization-b', 'Organization B', 'active');
INSERT INTO external_identities (id, principal_id, issuer, subject)
VALUES (
  '00000000-0000-0000-0000-000000000030',
  '00000000-0000-0000-0000-000000000001',
  'https://issuer.example.test',
  'subject-1'
);
INSERT INTO workspace_volumes (
  id, organization_id, kubernetes_pvc_uid, kubernetes_pvc_name, storage_class,
  capacity_bytes, access_mode, source, status, retention_policy
) VALUES (
  '00000000-0000-0000-0000-000000000040',
  '00000000-0000-0000-0000-000000000010',
  'pvc-uid-1', 'pvc-a', 'longhorn-ssd-orion', 1073741824,
  'ReadWriteOnce', 'created', 'available', 'retain'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO external_identities (id, principal_id, issuer, subject)
    VALUES (
      '00000000-0000-0000-0000-000000000031',
      '00000000-0000-0000-0000-000000000001',
      'https://issuer.example.test',
      'subject-1'
    );
    RAISE EXCEPTION 'duplicate OIDC identity was accepted';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO workspaces (
      id, organization_id, owner_principal_id, name, slug, desired_state, phase,
      image_profile, cpu_request_millis, cpu_limit_millis,
      memory_request_bytes, memory_limit_bytes, ephemeral_storage_bytes,
      egress_profile, volume_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000050',
      '00000000-0000-0000-0000-000000000020',
      '00000000-0000-0000-0000-000000000001',
      'Cross-org', 'cross-org', 'Stopped', 'Stopped', 'stable',
      500, 1000, 536870912, 1073741824, 1073741824, 'restricted',
      '00000000-0000-0000-0000-000000000040'
    );
    RAISE EXCEPTION 'cross-organization volume attachment was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO workspaces (
      id, organization_id, owner_principal_id, name, slug, desired_state, phase,
      image_profile, cpu_request_millis, cpu_limit_millis,
      memory_request_bytes, memory_limit_bytes, ephemeral_storage_bytes,
      egress_profile, volume_id
    ) VALUES (
      '00000000-0000-0000-0000-000000000051',
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000001',
      'Invalid resources', 'invalid-resources', 'Stopped', 'Stopped', 'stable',
      2000, 1000, 536870912, 1073741824, 1073741824, 'restricted',
      '00000000-0000-0000-0000-000000000040'
    );
    RAISE EXCEPTION 'CPU request above limit was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

ROLLBACK;
