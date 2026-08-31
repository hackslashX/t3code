#!/usr/bin/env bash
set -euo pipefail
ctx=${KUBE_CONTEXT:-okta-lyra-k3s}
ns=${TEST_NAMESPACE:-t3codes-testing}
image=${CONTROL_PLANE_IMAGE:-t3-control-plane:test}
work=$(mktemp -d)
control_id= operator_id= oidc_pid= forward_pid=
cleanup() {
  set +e
  [[ -n $operator_id ]] && docker rm -f "$operator_id" >/dev/null 2>&1
  [[ -n $control_id ]] && docker rm -f "$control_id" >/dev/null 2>&1
  [[ -n $oidc_pid ]] && kill "$oidc_pid" >/dev/null 2>&1
  [[ -n $forward_pid ]] && kill "$forward_pid" >/dev/null 2>&1
  [[ -n ${name:-} ]] && kubectl --context "$ctx" delete pod,service,networkpolicy "$name" -n "$ns" --ignore-not-found --wait=true >/dev/null 2>&1
  kubectl --context "$ctx" delete t3workspace --all -n "$ns" --ignore-not-found --wait=true >/dev/null 2>&1
  kubectl --context "$ctx" delete pvc -n "$ns" -l app.kubernetes.io/name=t3-workspace-volume --ignore-not-found --wait=true >/dev/null 2>&1
  [[ -f $work/operator-rbac.yaml ]] && kubectl --context "$ctx" delete -f "$work/operator-rbac.yaml" --ignore-not-found --wait=true >/dev/null 2>&1
  [[ -f $work/control-plane-rbac.yaml ]] && kubectl --context "$ctx" delete -f "$work/control-plane-rbac.yaml" --ignore-not-found --wait=true >/dev/null 2>&1
  kubectl --context "$ctx" delete -f apps/control-plane/kubernetes/t3workspace-crd.yaml --ignore-not-found --wait=true >/dev/null 2>&1
  kubectl --context "$ctx" delete -f spikes/hosted-workspace-k3s/postgres-migration-test.yaml --ignore-not-found --wait=true >/dev/null 2>&1
  rm -rf "$work"
}
trap cleanup EXIT
kubectl --context "$ctx" get --raw=/readyz >/dev/null
kubectl --context "$ctx" get namespace "$ns" >/dev/null
kubectl --context "$ctx" auth can-i create persistentvolumeclaims -n "$ns" | grep -qx yes
kubectl --context "$ctx" get storageclass longhorn-ssd-orion >/dev/null
kubectl --context "$ctx" apply -f apps/control-plane/kubernetes/t3workspace-crd.yaml >/dev/null
perl -pe "s/namespace: t3codes-hosted/namespace: $ns/g" \
  apps/control-plane/kubernetes/control-plane-rbac.yaml >"$work/control-plane-rbac.yaml"
kubectl --context "$ctx" apply -f "$work/control-plane-rbac.yaml" >/dev/null
perl -pe "s/namespace: t3codes-hosted/namespace: $ns/g" \
  apps/control-plane/kubernetes/operator-rbac.yaml >"$work/operator-rbac.yaml"
kubectl --context "$ctx" apply -f "$work/operator-rbac.yaml" >/dev/null
kubectl --context "$ctx" apply -f spikes/hosted-workspace-k3s/postgres-migration-test.yaml >/dev/null
kubectl --context "$ctx" wait --for=condition=Ready pod/phase0-postgres -n "$ns" --timeout=180s >/dev/null
kubectl --context "$ctx" port-forward -n "$ns" pod/phase0-postgres 15432:5432 >"$work/forward.log" 2>&1 & forward_pid=$!
for _ in 1 2 3 4 5; do grep -q 'Forwarding from' "$work/forward.log" && break; sleep 1; done
server=$(kubectl --context "$ctx" config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.server}')
ca_data=$(kubectl --context "$ctx" config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
skip_tls=$(kubectl --context "$ctx" config view --raw --minify --flatten -o jsonpath='{.clusters[0].cluster.insecure-skip-tls-verify}')
if [[ -n $ca_data ]]; then
  cluster_trust="certificate-authority-data: $ca_data"
elif [[ $skip_tls == true ]]; then
  cluster_trust='insecure-skip-tls-verify: true'
else
  printf 'Kubernetes context has neither embedded CA data nor insecure-skip-tls-verify\n' >&2
  exit 1
fi
service_token=$(kubectl --context "$ctx" create token t3-hosted-control-plane -n "$ns" --duration=10m)
cat >"$work/kubeconfig" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
  - name: e2e
    cluster:
      server: $server
      $cluster_trust
users:
  - name: control-plane
    user:
      token: $service_token
contexts:
  - name: e2e
    context:
      cluster: e2e
      user: control-plane
      namespace: $ns
current-context: e2e
KUBECONFIG
unset service_token
operator_token=$(kubectl --context "$ctx" create token t3-workspace-operator -n "$ns" --duration=10m)
cat >"$work/operator-kubeconfig" <<KUBECONFIG
apiVersion: v1
kind: Config
clusters:
  - name: e2e
    cluster:
      server: $server
      $cluster_trust
users:
  - name: operator
    user:
      token: $operator_token
contexts:
  - name: e2e
    context:
      cluster: e2e
      user: operator
      namespace: $ns
current-context: e2e
KUBECONFIG
unset operator_token cluster_trust ca_data skip_tls
printf '%s\n' 'postgresql://t3_hosted_test:phase0-disposable-password@127.0.0.1:15432/t3_hosted_test' >"$work/database-url"
printf '%s\n' test-client-secret >"$work/client-secret"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" >"$work/transaction-key"
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" >"$work/proxy-session-key"
openssl ecparam -name prime256v1 -genkey -noout -out "$work/assertion-private-key.pem" 2>/dev/null
openssl ec -in "$work/assertion-private-key.pem" -pubout -out "$work/assertion-public-key.pem" 2>/dev/null
cp spikes/hosted-workspace-k3s/workspace-catalog.json "$work/catalog.json"
printf '%s\n' '{"restricted":[]}' >"$work/egress-cidrs.json"
chmod 644 "$work"/*
PORT=18080 ISSUER=http://localhost:18080 CLIENT_ID=t3-hosted-test node spikes/hosted-control-plane-e2e/mock-oidc.mjs >"$work/oidc.log" 2>&1 & oidc_pid=$!
curl -fsS --retry 10 --retry-connrefused --retry-delay 1 http://localhost:18080/.well-known/openid-configuration >/dev/null
control_id=$(docker run -d --network host \
  -v "$work/database-url:/run/secrets/database-url:ro" -v "$work/client-secret:/run/secrets/client-secret:ro" \
  -v "$work/transaction-key:/run/secrets/transaction-key:ro" -v "$work/catalog.json:/run/config/catalog.json:ro" \
  -v "$work/assertion-private-key.pem:/run/secrets/assertion-private-key.pem:ro" \
  -v "$work/proxy-session-key:/run/secrets/proxy-session-key:ro" \
  -v "$work/kubeconfig:/run/secrets/kubeconfig:ro" \
  -e T3CODE_CONTROL_PLANE_DATABASE_URL_FILE=/run/secrets/database-url -e T3CODE_CONTROL_PLANE_OIDC_ISSUER=http://localhost:18080 \
  -e T3CODE_CONTROL_PLANE_OIDC_CLIENT_ID=t3-hosted-test -e T3CODE_CONTROL_PLANE_OIDC_CLIENT_SECRET_FILE=/run/secrets/client-secret \
  -e T3CODE_CONTROL_PLANE_OIDC_TRANSACTION_KEY_FILE=/run/secrets/transaction-key -e T3CODE_CONTROL_PLANE_PUBLIC_BASE_URL=http://localhost:13000 \
  -e T3CODE_CONTROL_PLANE_PORT=13000 -e T3CODE_CONTROL_PLANE_WORKSPACE_CATALOG_FILE=/run/config/catalog.json \
  -e T3CODE_HOSTED_ASSERTION_ISSUER=http://localhost:13000 -e T3CODE_HOSTED_ASSERTION_KEY_ID=e2e-key \
  -e T3CODE_HOSTED_ASSERTION_PRIVATE_KEY_FILE=/run/secrets/assertion-private-key.pem \
  -e T3CODE_WORKSPACE_PROXY_SESSION_KEY_FILE=/run/secrets/proxy-session-key \
  -e T3CODE_WORKSPACE_PROXY_HOST_SUFFIX=workspaces.example.test \
  -e T3CODE_WORKSPACE_PROXY_COOKIE_DOMAIN=.example.test \
  -e T3CODE_WORKSPACE_NAMESPACE="$ns" -e T3CODE_WORKSPACE_T3_IMAGE=nginx:alpine -e T3CODE_WORKSPACE_CODE_SERVER_IMAGE=ghcr.io/coder/code-server:latest \
  -e T3CODE_HOSTED_WORKSPACE_ISSUER=http://localhost:13000 -e T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_CONFIG_MAP=t3-hosted-auth-public-keys \
  -e T3CODE_KUBERNETES_KUBECONFIG_FILE=/run/secrets/kubeconfig "$image" start)
if ! curl -fsS --retry 20 --retry-connrefused --retry-delay 1 http://localhost:13000/readyz >/dev/null; then docker logs "$control_id"; exit 1; fi
invite_token=hosted-e2e-invitation-token
invite_hash=$(printf %s "$invite_token" | sha256sum | awk '{print $1}')
kubectl --context "$ctx" exec -i -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password psql -v ON_ERROR_STOP=1 -U t3_hosted_test -d t3_hosted_test <<SQL >/dev/null
INSERT INTO principals (id,display_name,email,status) VALUES ('00000000-0000-4000-8000-000000000001','Owner','owner@example.test','active');
INSERT INTO organizations (id,slug,name,status) VALUES ('00000000-0000-4000-8000-000000000010','e2e-org','E2E Org','active');
INSERT INTO organization_quotas (organization_id,max_workspaces,max_running_workspaces,max_cpu_millis,max_memory_bytes,max_storage_bytes) VALUES ('00000000-0000-4000-8000-000000000010',3,1,4000,8589934592,21474836480);
INSERT INTO organization_invitations (id,organization_id,email,role,token_hash,invited_by_principal_id,expires_at) VALUES ('00000000-0000-4000-8000-000000000040','00000000-0000-4000-8000-000000000010','invited@example.test','member',decode('$invite_hash','hex'),'00000000-0000-4000-8000-000000000001',now()+interval '1 hour');
SQL
stored_hash=$(kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
  psql -At -U t3_hosted_test -d t3_hosted_test -c "SELECT encode(token_hash, 'hex') FROM organization_invitations WHERE id = '00000000-0000-4000-8000-000000000040'")
if [[ $stored_hash != "$invite_hash" ]]; then
  printf 'invitation hash mismatch: expected=%s stored=%s\n' "$invite_hash" "$stored_hash" >&2
  exit 1
fi
curl -sSL -D "$work/login-headers" -c "$work/cookies" -b "$work/cookies" \
  "http://localhost:13000/auth/login?invitation_token=$invite_token&return_to=%2F" >"$work/login-response"
if ! curl -fsS -c "$work/cookies" -b "$work/cookies" http://localhost:13000/api/me >"$work/me.json"; then
  docker logs "$control_id"
  printf '%s\n' '--- login headers ---'
  grep -E '^(HTTP/|location:|set-cookie:)' "$work/login-headers" || true
  printf '%s\n' '--- login response ---'
  head -c 1000 "$work/login-response"
  printf '\n%s\n' '--- cookie jar ---'
  grep -v '^#' "$work/cookies" || true
  exit 1
fi
node -e "const v=require('$work/me.json'); if(v.organizations?.[0]?.role!=='member') process.exit(1)"
workspace_status=$(curl -sS -o "$work/workspace.json" -w '%{http_code}' -c "$work/cookies" -b "$work/cookies" \
  -H 'Origin: http://localhost:13000' -H 'Content-Type: application/json' \
  -d '{"name":"E2E Workspace","imageProfile":"stable","resources":{"cpuRequestMillis":100,"cpuLimitMillis":500,"memoryRequestBytes":268435456,"memoryLimitBytes":1073741824,"ephemeralStorageBytes":1073741824},"storage":{"kind":"new","storageClass":"longhorn-ssd-orion","requestedBytes":1073741824,"accessMode":"ReadWriteOnce","retentionPolicy":"retain"},"egressProfile":"restricted"}' \
  http://localhost:13000/api/organizations/00000000-0000-4000-8000-000000000010/workspaces)
if [[ $workspace_status != 201 ]]; then
  printf 'workspace creation failed: HTTP %s: ' "$workspace_status" >&2
  cat "$work/workspace.json" >&2
  printf '\n' >&2
  docker logs "$control_id" >&2
  exit 1
fi
workspace_id=$(node -e "process.stdout.write(require('$work/workspace.json').workspace.id)")
name=ws-$workspace_id
if ! kubectl --context "$ctx" wait --for=create "t3workspace/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'T3Workspace publication timed out\n' >&2
  kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
    psql -x -U t3_hosted_test -d t3_hosted_test \
    -c 'SELECT event_type, attempt_count, last_error FROM outbox_events ORDER BY created_at DESC LIMIT 1' >&2 || true
  docker logs "$control_id" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=create "pvc/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'PVC publication timed out\n' >&2
  docker logs "$control_id" >&2
  exit 1
fi
test "$(kubectl --context "$ctx" get "t3workspace/$name" -n "$ns" -o jsonpath='{.spec.workspaceId}')" = "$workspace_id"
operator_id=$(docker run -d --network host \
  -v "$work/operator-kubeconfig:/run/secrets/kubeconfig:ro" \
  -v "$work/egress-cidrs.json:/run/config/egress-cidrs.json:ro" \
  -e T3CODE_KUBERNETES_KUBECONFIG_FILE=/run/secrets/kubeconfig \
  -e T3CODE_WORKSPACE_OPERATOR_NAMESPACE="$ns" \
  -e T3CODE_WORKSPACE_OPERATOR_EGRESS_CIDRS_FILE=/run/config/egress-cidrs.json \
  "$image" operator)
if ! kubectl --context "$ctx" wait --for=create "service/$name" -n "$ns" --timeout=60s >/dev/null || \
   ! kubectl --context "$ctx" wait --for=create "networkpolicy/$name" -n "$ns" --timeout=60s >/dev/null || \
   ! kubectl --context "$ctx" wait --for=jsonpath='{.status.phase}'=Stopped "t3workspace/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'operator reconciliation timed out\n' >&2
  docker logs "$operator_id" >&2
  exit 1
fi
projected=
for _ in 1 2 3 4 5 6 7 8 9 10; do
  projected=$(kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
    psql -At -U t3_hosted_test -d t3_hosted_test \
    -c "SELECT phase || '|' || observed_generation || '|' || (SELECT count(*) FROM workspace_conditions WHERE workspace_id = '$workspace_id') FROM workspaces WHERE id = '$workspace_id'")
  [[ $projected == Stopped\|* && $projected != *\|0 ]] && break
  sleep 1
done
if [[ $projected != Stopped\|* || $projected == *\|0 ]]; then
  printf 'PostgreSQL stopped-status projection failed: %s\n' "$projected" >&2
  docker logs "$control_id" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=jsonpath='{.status.phase}'=Bound "pvc/$name" -n "$ns" --timeout=180s >/dev/null; then
  printf 'workspace PVC did not bind\n' >&2
  kubectl --context "$ctx" describe "pvc/$name" -n "$ns" >&2 || true
  exit 1
fi
state_status=$(curl -sS -o "$work/desired-state.json" -w '%{http_code}' -c "$work/cookies" -b "$work/cookies" \
  -H 'Origin: http://localhost:13000' -H 'Content-Type: application/json' \
  -d '{"desiredState":"Running","expectedGeneration":0}' \
  "http://localhost:13000/api/organizations/00000000-0000-4000-8000-000000000010/workspaces/$workspace_id/desired-state")
if [[ $state_status != 200 ]]; then
  printf 'workspace start failed: HTTP %s: ' "$state_status" >&2
  cat "$work/desired-state.json" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=jsonpath='{.spec.desiredState}'=Running "t3workspace/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'running desired-state publication timed out\n' >&2
  docker logs "$control_id" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=create "pod/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'operator Pod creation timed out; status=' >&2
  kubectl --context "$ctx" get "t3workspace/$name" -n "$ns" -o jsonpath='{.status}' >&2 || true
  printf '\n' >&2
  docker logs "$operator_id" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=jsonpath='{.status.phase}'=Starting "t3workspace/$name" -n "$ns" --timeout=60s >/dev/null; then
  printf 'operator Starting status timed out; status=' >&2
  kubectl --context "$ctx" get "t3workspace/$name" -n "$ns" -o jsonpath='{.status}' >&2 || true
  printf '\n' >&2
  docker logs "$operator_id" >&2
  exit 1
fi
for _ in 1 2 3 4 5 6 7 8 9 10; do
  projected=$(kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
    psql -At -U t3_hosted_test -d t3_hosted_test \
    -c "SELECT phase || '|' || observed_generation || '|' || (SELECT count(*) FROM workspace_conditions WHERE workspace_id = '$workspace_id') FROM workspaces WHERE id = '$workspace_id'")
  [[ $projected == Starting\|1\|* ]] && break
  sleep 1
done
if [[ $projected != Starting\|1\|* ]]; then
  printf 'PostgreSQL starting-status projection failed: %s\n' "$projected" >&2
  docker logs "$control_id" >&2
  docker logs "$operator_id" >&2
  exit 1
fi
docker rm -f "$operator_id" >/dev/null
operator_id=
kubectl --context "$ctx" patch "t3workspace/$name" -n "$ns" --subresource=status --type=merge \
  -p "{\"status\":{\"observedGeneration\":2,\"observedWorkspaceGeneration\":1,\"phase\":\"Ready\",\"environmentId\":\"environment-e2e\",\"conditions\":[{\"type\":\"StorageReady\",\"status\":\"True\",\"reason\":\"VolumeBound\",\"message\":\"Workspace volume is bound.\",\"observedGeneration\":2,\"lastTransitionTime\":\"2026-08-10T00:00:00.000Z\"},{\"type\":\"PodReady\",\"status\":\"True\",\"reason\":\"ContainersReady\",\"message\":\"Workspace containers are ready.\",\"observedGeneration\":2,\"lastTransitionTime\":\"2026-08-10T00:00:00.000Z\"}]}}" >/dev/null
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ready_phase=$(kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
    psql -At -U t3_hosted_test -d t3_hosted_test -c "SELECT phase FROM workspaces WHERE id = '$workspace_id'")
  [[ $ready_phase == Ready ]] && break
  sleep 1
done
[[ ${ready_phase:-} == Ready ]] || { printf 'Ready projection failed\n' >&2; exit 1; }
assertion_status=$(curl -sS -o "$work/assertion.json" -w '%{http_code}' -X POST \
  -c "$work/cookies" -b "$work/cookies" -H 'Origin: http://localhost:13000' \
  "http://localhost:13000/api/organizations/00000000-0000-4000-8000-000000000010/workspaces/$workspace_id/access-assertion")
if [[ $assertion_status != 200 ]]; then
  printf 'workspace assertion issuance failed: HTTP %s: ' "$assertion_status" >&2
  cat "$work/assertion.json" >&2
  exit 1
fi
node - "$work/assertion.json" "$work/assertion-public-key.pem" "$workspace_id" <<'NODE'
const [jsonFile, keyFile, workspaceId] = process.argv.slice(2);
const { readFileSync } = require("node:fs");
const { verify } = require("node:crypto");
const value = JSON.parse(readFileSync(jsonFile, "utf8"));
const [header, payload, signature] = value.assertion.split(".");
const claims = JSON.parse(Buffer.from(payload, "base64url"));
if (claims.workspace !== workspaceId || claims.environment !== "environment-e2e") process.exit(1);
if (!verify("sha256", Buffer.from(`${header}.${payload}`), { key: readFileSync(keyFile), dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))) process.exit(1);
NODE
delete_status=$(curl -sS -o "$work/delete.json" -w '%{http_code}' -X DELETE \
  -c "$work/cookies" -b "$work/cookies" \
  -H 'Origin: http://localhost:13000' -H 'Content-Type: application/json' \
  -d '{"volumePolicy":"retain","expectedGeneration":1}' \
  "http://localhost:13000/api/organizations/00000000-0000-4000-8000-000000000010/workspaces/$workspace_id")
if [[ $delete_status != 202 ]]; then
  printf 'workspace deletion failed: HTTP %s: ' "$delete_status" >&2
  cat "$work/delete.json" >&2
  exit 1
fi
if ! kubectl --context "$ctx" wait --for=delete "t3workspace/$name" -n "$ns" --timeout=120s >/dev/null; then
  printf 'workspace Kubernetes cleanup timed out\n' >&2
  kubectl --context "$ctx" get "t3workspace/$name" -n "$ns" -o yaml >&2 || true
  kubectl --context "$ctx" get pod,service,networkpolicy -n "$ns" -o yaml >&2 || true
  docker logs "$control_id" >&2
  docker logs "$operator_id" >&2
  exit 1
fi
retained=
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  retained=$(kubectl --context "$ctx" exec -n "$ns" phase0-postgres -- env PGPASSWORD=phase0-disposable-password \
    psql -At -U t3_hosted_test -d t3_hosted_test \
    -c "SELECT status || '|' || coalesce(attached_workspace_id::text, '') FROM workspace_volumes WHERE kubernetes_pvc_name = '$name'")
  [[ $retained == 'available|' ]] && break
  sleep 1
done
if [[ $retained != 'available|' ]] || ! kubectl --context "$ctx" get "pvc/$name" -n "$ns" >/dev/null; then
  printf 'retained volume finalization failed: %s\n' "$retained" >&2
  docker logs "$control_id" >&2
  exit 1
fi
printf 'E2E_OK workspace=%s projected=%s deletion=retained\n' "$workspace_id" "$projected"
