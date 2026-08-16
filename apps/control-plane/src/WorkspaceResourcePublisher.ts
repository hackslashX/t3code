import { CoreV1Api, CustomObjectsApi, type V1PersistentVolumeClaim } from "@kubernetes/client-node";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as KubernetesConfig from "./KubernetesConfig.ts";
import type { WorkspaceDeletionTarget } from "./WorkspaceDeletion.ts";
import type { WorkspaceProjectionResult } from "./WorkspaceProjection.ts";

const GROUP = "hosted.t3.codes";
const VERSION = "v1alpha1";
const PLURAL = "t3workspaces";
const FIELD_MANAGER = "t3-hosted-control-plane";

export class WorkspaceResourcePublisherError extends Schema.TaggedErrorClass<WorkspaceResourcePublisherError>()(
  "WorkspaceResourcePublisherError",
  {
    reason: Schema.Literals(["kubernetes_request_failed", "pvc_conflict"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class WorkspaceResourcePublisher extends Context.Service<
  WorkspaceResourcePublisher,
  {
    readonly apply: (
      projection: WorkspaceProjectionResult,
    ) => Effect.Effect<{ readonly pvcUid?: string }, WorkspaceResourcePublisherError>;
    readonly remove: (
      target: WorkspaceDeletionTarget,
      namespace: string,
    ) => Effect.Effect<{ readonly complete: boolean }, WorkspaceResourcePublisherError>;
  }
>()("@t3tools/control-plane/WorkspaceResourcePublisher") {}

const statusCode = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = cause as {
    readonly code?: unknown;
    readonly statusCode?: unknown;
    readonly response?: { readonly statusCode?: unknown; readonly status?: unknown };
  };
  const status =
    value.code ?? value.statusCode ?? value.response?.statusCode ?? value.response?.status;
  return typeof status === "number" ? status : undefined;
};

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new WorkspaceResourcePublisherError({ reason: "kubernetes_request_failed", cause }),
  });

export const layer = Layer.effect(
  WorkspaceResourcePublisher,
  Effect.gen(function* () {
    const config = yield* KubernetesConfig.KubernetesConfig;
    const core = config.makeApiClient(CoreV1Api);
    const custom = config.makeApiClient(CustomObjectsApi);
    const apply: WorkspaceResourcePublisher["Service"]["apply"] = Effect.fn(
      "WorkspaceResourcePublisher.apply",
    )(function* (projection) {
      const resource = projection.resource;
      let pvcUid: string | undefined;
      if (projection.persistentVolumeClaim !== undefined) {
        const desiredPvc = projection.persistentVolumeClaim as unknown as V1PersistentVolumeClaim;
        const pvcName = desiredPvc.metadata?.name;
        const pvcNamespace = desiredPvc.metadata?.namespace;
        if (pvcName === undefined || pvcNamespace === undefined) {
          return yield* new WorkspaceResourcePublisherError({ reason: "pvc_conflict" });
        }
        const currentPvc = yield* attempt(() =>
          core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: pvcNamespace }),
        ).pipe(
          Effect.catch((error) =>
            statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
          ),
        );
        if (currentPvc === undefined) {
          const created = yield* attempt(() =>
            core.createNamespacedPersistentVolumeClaim({
              namespace: pvcNamespace,
              body: desiredPvc,
            }),
          );
          pvcUid = created.metadata?.uid;
        } else {
          pvcUid = currentPvc.metadata?.uid;
          const labels = currentPvc.metadata?.labels;
          const desiredLabels = desiredPvc.metadata?.labels;
          const matches =
            labels?.["hosted.t3.codes/organization-id"] ===
              desiredLabels?.["hosted.t3.codes/organization-id"] &&
            labels?.["hosted.t3.codes/volume-id"] ===
              desiredLabels?.["hosted.t3.codes/volume-id"] &&
            currentPvc.spec?.storageClassName === desiredPvc.spec?.storageClassName &&
            currentPvc.spec?.accessModes?.[0] === desiredPvc.spec?.accessModes?.[0] &&
            currentPvc.spec?.resources?.requests?.storage ===
              desiredPvc.spec?.resources?.requests?.storage;
          if (!matches) {
            return yield* new WorkspaceResourcePublisherError({ reason: "pvc_conflict" });
          }
        }
      }
      const current = yield* attempt(() =>
        custom.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: resource.metadata.namespace,
          plural: PLURAL,
          name: resource.metadata.name,
        }),
      ).pipe(
        Effect.catch((error) =>
          statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
        ),
      );
      const body = {
        apiVersion: `${GROUP}/${VERSION}`,
        kind: "T3Workspace",
        metadata: {
          name: resource.metadata.name,
          namespace: resource.metadata.namespace,
          ...(typeof current !== "object" || current === null
            ? {}
            : {
                resourceVersion: (
                  current as { readonly metadata?: { readonly resourceVersion?: string } }
                ).metadata?.resourceVersion,
              }),
        },
        spec: resource.spec,
      };
      if (current === undefined) {
        yield* attempt(() =>
          custom.createNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace: resource.metadata.namespace,
            plural: PLURAL,
            body,
            fieldManager: FIELD_MANAGER,
          }),
        );
      } else {
        yield* attempt(() =>
          custom.replaceNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace: resource.metadata.namespace,
            plural: PLURAL,
            name: resource.metadata.name,
            body,
            fieldManager: FIELD_MANAGER,
          }),
        );
      }
      return pvcUid === undefined ? {} : { pvcUid };
    });
    const remove: WorkspaceResourcePublisher["Service"]["remove"] = Effect.fn(
      "WorkspaceResourcePublisher.remove",
    )(function* (target, namespace) {
      const resource = yield* attempt(() =>
        custom.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace,
          plural: PLURAL,
          name: target.resourceName,
        }),
      ).pipe(
        Effect.catch((error) =>
          statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
        ),
      );
      if (resource !== undefined) {
        yield* attempt(() =>
          custom.deleteNamespacedCustomObject({
            group: GROUP,
            version: VERSION,
            namespace,
            plural: PLURAL,
            name: target.resourceName,
            propagationPolicy: "Foreground",
          }),
        ).pipe(
          Effect.catch((error) =>
            statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
          ),
        );
        return { complete: false };
      }
      if (target.volumePolicy === "retain") return { complete: true };
      if (target.pvcUid === undefined) {
        return yield* new WorkspaceResourcePublisherError({ reason: "pvc_conflict" });
      }
      const pvc = yield* attempt(() =>
        core.readNamespacedPersistentVolumeClaim({ name: target.pvcName, namespace }),
      ).pipe(
        Effect.catch((error) =>
          statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
        ),
      );
      if (pvc === undefined) return { complete: true };
      if (
        pvc.metadata?.uid !== target.pvcUid ||
        pvc.metadata?.labels?.["hosted.t3.codes/volume-id"] !== target.volumeId
      ) {
        return yield* new WorkspaceResourcePublisherError({ reason: "pvc_conflict" });
      }
      yield* attempt(() =>
        core.deleteNamespacedPersistentVolumeClaim({ name: target.pvcName, namespace }),
      ).pipe(
        Effect.catch((error) =>
          statusCode(error.cause) === 404 ? Effect.void : Effect.fail(error),
        ),
      );
      return { complete: false };
    });
    return WorkspaceResourcePublisher.of({ apply, remove });
  }),
);
