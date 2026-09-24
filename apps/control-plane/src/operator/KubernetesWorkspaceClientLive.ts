import { isDeepStrictEqual } from "node:util";
import {
  CoreV1Api,
  CustomObjectsApi,
  NetworkingV1Api,
  type V1NetworkPolicy,
  type V1Pod,
  type V1Service,
} from "@kubernetes/client-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as KubernetesConfig from "../KubernetesConfig.ts";
import {
  KubernetesWorkspaceClient,
  KubernetesWorkspaceClientError,
} from "./KubernetesWorkspaceClient.ts";
import type { WorkspaceStatusCondition } from "./WorkspaceReconciler.ts";
import {
  renderWorkspaceResources,
  type T3WorkspaceResource,
  type WorkspaceRendererOptions,
} from "./WorkspaceRenderer.ts";

const GROUP = "hosted.t3.codes";
const VERSION = "v1alpha1";
const PLURAL = "t3workspaces";
const FIELD_MANAGER = "t3-workspace-operator";

const errorStatus = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = cause as {
    readonly statusCode?: unknown;
    readonly code?: unknown;
    readonly response?: { readonly statusCode?: unknown; readonly status?: unknown };
  };
  const status =
    value.statusCode ?? value.code ?? value.response?.statusCode ?? value.response?.status;
  return typeof status === "number" ? status : undefined;
};

const attempt = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new KubernetesWorkspaceClientError({ operation, cause }),
  });

const conditionEquals = (
  left: WorkspaceStatusCondition | undefined,
  right: WorkspaceStatusCondition,
) =>
  left !== undefined &&
  left.type === right.type &&
  left.status === right.status &&
  left.reason === right.reason &&
  left.message === right.message &&
  left.observedGeneration === right.observedGeneration &&
  left.lastTransitionTime === right.lastTransitionTime;

const statusEquals = (
  current: T3WorkspaceResource & {
    readonly status?: {
      readonly observedGeneration?: number;
      readonly phase?: string;
      readonly conditions?: ReadonlyArray<WorkspaceStatusCondition>;
    };
  },
  next: {
    readonly observedGeneration: number;
    readonly phase: string;
    readonly conditions: ReadonlyArray<WorkspaceStatusCondition>;
  },
) => {
  const currentConditions = current.status?.conditions ?? [];
  return (
    current.status?.observedGeneration === next.observedGeneration &&
    current.status.phase === next.phase &&
    currentConditions.length === next.conditions.length &&
    next.conditions.every((condition) =>
      conditionEquals(
        currentConditions.find((item) => item.type === condition.type),
        condition,
      ),
    )
  );
};

export const layer = (options: WorkspaceRendererOptions) =>
  Layer.effect(
    KubernetesWorkspaceClient,
    Effect.gen(function* () {
      const kubeConfig = yield* KubernetesConfig.KubernetesConfig;
      const core = kubeConfig.makeApiClient(CoreV1Api);
      const networking = kubeConfig.makeApiClient(NetworkingV1Api);
      const custom = kubeConfig.makeApiClient(CustomObjectsApi);

      const getWorkspace = (namespace: string, name: string) =>
        attempt("getWorkspace", () =>
          custom.getNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace,
            plural: PLURAL,
            name,
          }),
        ).pipe(Effect.map((value) => value as T3WorkspaceResource));

      const optional = <A>(operation: string, run: () => Promise<A>) =>
        attempt(operation, run).pipe(
          Effect.catch((error) =>
            errorStatus(error.cause) === 404 ? Effect.void : Effect.fail(error),
          ),
        );

      const observe: KubernetesWorkspaceClient["Service"]["observe"] = Effect.fn(
        "KubernetesWorkspaceClientLive.observe",
      )(function* (workspace) {
        const pvc = yield* optional("readPvc", () =>
          core.readNamespacedPersistentVolumeClaim({
            name: workspace.spec.pvcName,
            namespace: workspace.metadata.namespace,
          }),
        );
        const pod = yield* optional("readPod", () =>
          core.readNamespacedPod({
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
          }),
        );
        const current = workspace as T3WorkspaceResource & {
          readonly status?: { readonly conditions?: ReadonlyArray<WorkspaceStatusCondition> };
        };
        const ready = pod?.status?.conditions?.some(
          (item) => item.type === "Ready" && item.status === "True",
        );
        return {
          ...(pvc?.status?.phase === undefined
            ? {}
            : { pvcPhase: pvc.status.phase as "Pending" | "Bound" | "Lost" }),
          ...(pod === undefined
            ? {}
            : {
                pod: {
                  phase: (pod.status?.phase ?? "Unknown") as
                    | "Pending"
                    | "Running"
                    | "Succeeded"
                    | "Failed"
                    | "Unknown",
                  ready: ready === true,
                  ...(pod.status?.reason === undefined ? {} : { reason: pod.status.reason }),
                  ...(pod.status?.message === undefined ? {} : { message: pod.status.message }),
                },
              }),
          ...(current.status?.conditions === undefined
            ? {}
            : { currentConditions: current.status.conditions }),
        };
      });

      const applyService: KubernetesWorkspaceClient["Service"]["applyService"] = Effect.fn(
        "KubernetesWorkspaceClientLive.applyService",
      )(function* (workspace) {
        const desired = renderWorkspaceResources(workspace, options).service as V1Service;
        const current = yield* optional("readService", () =>
          core.readNamespacedService({
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
          }),
        );
        if (current === undefined) {
          yield* attempt("createService", () =>
            core.createNamespacedService({
              namespace: workspace.metadata.namespace,
              body: desired,
            }),
          );
          return;
        }
        if (
          current.spec?.type === desired.spec?.type &&
          isDeepStrictEqual(current.spec?.selector, desired.spec?.selector) &&
          isDeepStrictEqual(current.spec?.ports, desired.spec?.ports)
        ) {
          return;
        }
        if (current.metadata?.resourceVersion !== undefined) {
          desired.metadata!.resourceVersion = current.metadata.resourceVersion;
        }
        desired.spec = {
          ...desired.spec,
          ...(current.spec?.clusterIP === undefined ? {} : { clusterIP: current.spec.clusterIP }),
          ...(current.spec?.clusterIPs === undefined
            ? {}
            : { clusterIPs: current.spec.clusterIPs }),
          ...(current.spec?.ipFamilies === undefined
            ? {}
            : { ipFamilies: current.spec.ipFamilies }),
          ...(current.spec?.ipFamilyPolicy === undefined
            ? {}
            : { ipFamilyPolicy: current.spec.ipFamilyPolicy }),
        };
        yield* attempt("replaceService", () =>
          core.replaceNamespacedService({
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
            body: desired,
            fieldManager: FIELD_MANAGER,
          }),
        );
      });

      const applyNetworkPolicy: KubernetesWorkspaceClient["Service"]["applyNetworkPolicy"] =
        Effect.fn("KubernetesWorkspaceClientLive.applyNetworkPolicy")(function* (workspace) {
          const desired = renderWorkspaceResources(workspace, options)
            .networkPolicy as V1NetworkPolicy;
          const current = yield* optional("readNetworkPolicy", () =>
            networking.readNamespacedNetworkPolicy({
              name: workspace.metadata.name,
              namespace: workspace.metadata.namespace,
            }),
          );
          if (current === undefined) {
            yield* attempt("createNetworkPolicy", () =>
              networking.createNamespacedNetworkPolicy({
                namespace: workspace.metadata.namespace,
                body: desired,
              }),
            );
            return;
          }
          if (isDeepStrictEqual(current.spec, desired.spec)) return;
          if (current.metadata?.resourceVersion !== undefined) {
            desired.metadata!.resourceVersion = current.metadata.resourceVersion;
          }
          yield* attempt("replaceNetworkPolicy", () =>
            networking.replaceNamespacedNetworkPolicy({
              name: workspace.metadata.name,
              namespace: workspace.metadata.namespace,
              body: desired,
              fieldManager: FIELD_MANAGER,
            }),
          );
        });

      const applyPod: KubernetesWorkspaceClient["Service"]["applyPod"] = Effect.fn(
        "KubernetesWorkspaceClientLive.applyPod",
      )(function* (workspace) {
        const desired = renderWorkspaceResources(workspace, options).pod as V1Pod | undefined;
        if (desired === undefined) return;
        const current = yield* optional("readPod", () =>
          core.readNamespacedPod({
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
          }),
        );
        if (current === undefined) {
          yield* attempt("createPod", () =>
            core.createNamespacedPod({ namespace: workspace.metadata.namespace, body: desired }),
          );
          return;
        }
        if (
          current.metadata?.annotations?.["hosted.t3.codes/generation"] !==
            desired.metadata?.annotations?.["hosted.t3.codes/generation"] ||
          current.metadata?.annotations?.["hosted.t3.codes/image-revision"] !==
            desired.metadata?.annotations?.["hosted.t3.codes/image-revision"]
        ) {
          yield* attempt("deleteOutdatedPod", () =>
            core.deleteNamespacedPod({
              name: workspace.metadata.name,
              namespace: workspace.metadata.namespace,
            }),
          );
        }
      });

      const deletePod: KubernetesWorkspaceClient["Service"]["deletePod"] = Effect.fn(
        "KubernetesWorkspaceClientLive.deletePod",
      )(function* (workspace) {
        yield* optional("deletePod", () =>
          core.deleteNamespacedPod({
            name: workspace.metadata.name,
            namespace: workspace.metadata.namespace,
          }),
        );
      });

      const patchStatusIfChanged: KubernetesWorkspaceClient["Service"]["patchStatusIfChanged"] =
        Effect.fn("KubernetesWorkspaceClientLive.patchStatus")(function* (workspace, status) {
          if (statusEquals(workspace, status)) return;
          yield* attempt("replaceWorkspaceStatus", () =>
            custom.replaceNamespacedCustomObjectStatus({
              group: GROUP,
              version: VERSION,
              namespace: workspace.metadata.namespace,
              plural: PLURAL,
              name: workspace.metadata.name,
              body: {
                apiVersion: `${GROUP}/${VERSION}`,
                kind: "T3Workspace",
                metadata: {
                  name: workspace.metadata.name,
                  namespace: workspace.metadata.namespace,
                  ...(workspace.metadata.uid === undefined ? {} : { uid: workspace.metadata.uid }),
                  ...(workspace.metadata.resourceVersion === undefined
                    ? {}
                    : { resourceVersion: workspace.metadata.resourceVersion }),
                },
                status,
              },
              fieldManager: FIELD_MANAGER,
            }),
          );
        });

      return KubernetesWorkspaceClient.of({
        getWorkspace,
        observe,
        applyService,
        applyNetworkPolicy,
        applyPod,
        deletePod,
        patchStatusIfChanged,
      });
    }),
  );
