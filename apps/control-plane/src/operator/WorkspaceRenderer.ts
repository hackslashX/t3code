export interface T3WorkspaceResource {
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly uid?: string;
    readonly generation?: number;
    readonly resourceVersion?: string;
    readonly deletionTimestamp?: string;
  };
  readonly spec: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly desiredState: "Running" | "Stopped";
    readonly workspaceGeneration: number;
    readonly pvcName: string;
    readonly nodeName: string;
    readonly environmentId: string;
    readonly imageProfile: string;
    readonly egressProfile: string;
    readonly t3Image: string;
    readonly codeServerImage: string;
    readonly hostedAuth: {
      readonly issuer: string;
      readonly publicKeysConfigMap: string;
    };
    readonly resources: {
      readonly cpuRequest: string;
      readonly cpuLimit: string;
      readonly memoryRequest: string;
      readonly memoryLimit: string;
      readonly ephemeralStorage: string;
    };
    readonly gpuClass?: string;
    readonly gpuCount?: number;
  };
}

export interface WorkspaceRendererOptions {
  readonly proxyPodLabels: Readonly<Record<string, string>>;
  readonly dnsNamespaceLabels: Readonly<Record<string, string>>;
  readonly egressCidrsByProfile: Readonly<Record<string, ReadonlyArray<string>>>;
}

const labelsFor = (workspace: T3WorkspaceResource) => ({
  "app.kubernetes.io/name": "t3-workspace",
  "app.kubernetes.io/component": "workspace",
  "hosted.t3.codes/workspace-id": workspace.spec.workspaceId,
  "hosted.t3.codes/organization-id": workspace.spec.organizationId,
});

const ownerReferencesFor = (workspace: T3WorkspaceResource) =>
  workspace.metadata.uid === undefined
    ? []
    : [
        {
          apiVersion: "hosted.t3.codes/v1alpha1",
          kind: "T3Workspace",
          name: workspace.metadata.name,
          uid: workspace.metadata.uid,
          controller: true,
          blockOwnerDeletion: true,
        },
      ];

const containerSecurityContext = {
  allowPrivilegeEscalation: false,
  capabilities: { drop: ["ALL"] },
  readOnlyRootFilesystem: true,
  runAsNonRoot: true,
  seccompProfile: { type: "RuntimeDefault" },
} as const;

export function renderWorkspaceResources(
  workspace: T3WorkspaceResource,
  options: WorkspaceRendererOptions,
) {
  const labels = labelsFor(workspace);
  const ownerReferences = ownerReferencesFor(workspace);
  const pod =
    workspace.spec.desiredState === "Stopped"
      ? undefined
      : {
          apiVersion: "v1",
          kind: "Pod",
          metadata: {
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
            labels,
            annotations: {
              "hosted.t3.codes/generation": String(workspace.metadata.generation ?? 0),
            },
            ownerReferences,
          },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            restartPolicy: "Always",
            nodeSelector: { "kubernetes.io/hostname": workspace.spec.nodeName },
            securityContext: {
              runAsNonRoot: true,
              seccompProfile: { type: "RuntimeDefault" },
              fsGroup: 1000,
              fsGroupChangePolicy: "OnRootMismatch",
            },
            initContainers: [
              {
                name: "environment-id",
                image: workspace.spec.t3Image,
                imagePullPolicy: "Always",
                command: ["sh", "-c"],
                args: [
                  "mkdir -p /home/workspace/.t3/userdata; if [ ! -s /home/workspace/.t3/userdata/environment-id ]; then printf '%s\\n' \"$T3CODE_ENVIRONMENT_ID\" > /home/workspace/.t3/userdata/environment-id; fi",
                ],
                env: [{ name: "T3CODE_ENVIRONMENT_ID", value: workspace.spec.environmentId }],
                securityContext: containerSecurityContext,
                volumeMounts: [{ name: "workspace", mountPath: "/home/workspace" }],
              },
            ],
            containers: [
              {
                name: "runtime",
                image: workspace.spec.t3Image,
                imagePullPolicy: "Always",
                securityContext: containerSecurityContext,
                env: [
                  { name: "HOME", value: "/home/workspace" },
                  {
                    name: "T3CODE_HOSTED_WORKSPACE_ISSUER",
                    value: workspace.spec.hostedAuth.issuer,
                  },
                  {
                    name: "T3CODE_HOSTED_WORKSPACE_ID",
                    value: workspace.spec.workspaceId,
                  },
                  {
                    name: "T3CODE_HOSTED_WORKSPACE_PUBLIC_KEYS_DIR",
                    value: "/var/run/t3-hosted-auth/keys",
                  },
                  { name: "T3CODE_HOME", value: "/home/workspace/.t3" },
                ],
                ports: [
                  { name: "t3", containerPort: 3000, protocol: "TCP" },
                  { name: "code", containerPort: 3001, protocol: "TCP" },
                ],
                resources: {
                  requests: {
                    cpu: workspace.spec.resources.cpuRequest,
                    memory: workspace.spec.resources.memoryRequest,
                    "ephemeral-storage": workspace.spec.resources.ephemeralStorage,
                  },
                  limits: {
                    cpu: workspace.spec.resources.cpuLimit,
                    memory: workspace.spec.resources.memoryLimit,
                    "ephemeral-storage": workspace.spec.resources.ephemeralStorage,
                    ...(workspace.spec.gpuClass === undefined
                      ? {}
                      : { [workspace.spec.gpuClass]: workspace.spec.gpuCount }),
                  },
                },
                volumeMounts: [
                  { name: "workspace", mountPath: "/home/workspace" },
                  {
                    name: "hosted-auth-public-keys",
                    mountPath: "/var/run/t3-hosted-auth/keys",
                    readOnly: true,
                  },
                  { name: "tmp", mountPath: "/tmp" },
                ],
                readinessProbe: {
                  exec: {
                    command: [
                      "sh",
                      "-c",
                      "curl -fsS http://127.0.0.1:3000/ >/dev/null && curl -fsS http://127.0.0.1:3001/healthz >/dev/null",
                    ],
                  },
                  periodSeconds: 5,
                  failureThreshold: 12,
                },
              },
            ],
            volumes: [
              { name: "workspace", persistentVolumeClaim: { claimName: workspace.spec.pvcName } },
              {
                name: "hosted-auth-public-keys",
                configMap: { name: workspace.spec.hostedAuth.publicKeysConfigMap },
              },
              { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
            ],
          },
        };
  const service = {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name: workspace.metadata.name,
      namespace: workspace.metadata.namespace,
      labels,
      ownerReferences,
    },
    spec: {
      type: "ClusterIP",
      selector: labels,
      ports: [
        { name: "t3", port: 3000, targetPort: "t3", protocol: "TCP" },
        { name: "code", port: 3001, targetPort: "code", protocol: "TCP" },
      ],
    },
  };
  const networkPolicy = {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: workspace.metadata.name,
      namespace: workspace.metadata.namespace,
      labels,
      ownerReferences,
    },
    spec: {
      podSelector: { matchLabels: labels },
      policyTypes: ["Ingress", "Egress"],
      ingress: [
        {
          from: [{ podSelector: { matchLabels: options.proxyPodLabels } }],
          ports: [
            { protocol: "TCP", port: 3000 },
            { protocol: "TCP", port: 3001 },
          ],
        },
      ],
      egress: [
        {
          to: [{ namespaceSelector: { matchLabels: options.dnsNamespaceLabels } }],
          ports: [
            { protocol: "UDP", port: 53 },
            { protocol: "TCP", port: 53 },
          ],
        },
        ...(options.egressCidrsByProfile[workspace.spec.egressProfile] ?? []).map((cidr) => ({
          // Workspace runtimes need package managers, Git transports, provider APIs, and
          // arbitrary development services. The profile controls destination CIDRs.
          to: [{ ipBlock: { cidr } }],
        })),
      ],
    },
  };
  return { pod, service, networkPolicy };
}
