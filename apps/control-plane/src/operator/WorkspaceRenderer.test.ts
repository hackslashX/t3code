import { assert, it } from "@effect/vitest";

import { renderWorkspaceResources, type T3WorkspaceResource } from "./WorkspaceRenderer.ts";

const workspace: T3WorkspaceResource = {
  metadata: {
    name: "workspace-123",
    namespace: "t3codes-hosted",
    uid: "00000000-0000-0000-0000-000000000099",
  },
  spec: {
    organizationId: "00000000-0000-0000-0000-000000000010",
    workspaceId: "00000000-0000-0000-0000-000000000020",
    desiredState: "Running",
    workspaceGeneration: 0,
    pvcName: "workspace-123",
    nodeName: "orion",
    environmentId: "00000000-0000-4000-8000-000000000001",
    imageProfile: "stable",
    egressProfile: "restricted",
    t3Image: "registry.example.test/t3@sha256:abc",
    codeServerImage: "registry.example.test/code-server@sha256:def",
    hostedAuth: {
      issuer: "https://hosted.example.test",
      publicKeysConfigMap: "hosted-auth-public-keys",
    },
    resources: {
      cpuRequest: "500m",
      cpuLimit: "2000m",
      memoryRequest: "1073741824",
      memoryLimit: "4294967296",
      ephemeralStorage: "2147483648",
    },
  },
};

const options = {
  proxyPodLabels: { "app.kubernetes.io/component": "workspace-proxy" },
  dnsNamespaceLabels: { "kubernetes.io/metadata.name": "kube-system" },
  egressCidrsByProfile: { restricted: ["10.20.0.0/16"] },
};

it("renders a restricted unified workspace runtime pod", () => {
  const rendered = renderWorkspaceResources(workspace, options);
  assert.isDefined(rendered.pod);
  assert.equal(rendered.pod.spec.automountServiceAccountToken, false);
  assert.equal(rendered.pod.spec.containers.length, 1);
  for (const container of rendered.pod.spec.containers) {
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  }
  assert.equal(rendered.networkPolicy.spec.ingress.length, 1);
  const egressTarget = rendered.networkPolicy.spec.egress[1]?.to[0];
  assert(egressTarget !== undefined && "ipBlock" in egressTarget);
  assert.deepEqual(egressTarget.ipBlock, { cidr: "10.20.0.0/16" });
  assert.equal(rendered.service.spec.ports.length, 2);
});

it("does not render a pod for a stopped workspace", () => {
  const rendered = renderWorkspaceResources(
    { ...workspace, spec: { ...workspace.spec, desiredState: "Stopped" } },
    options,
  );
  assert.isUndefined(rendered.pod);
  assert.equal(rendered.service.kind, "Service");
  assert.equal(rendered.networkPolicy.kind, "NetworkPolicy");
});
