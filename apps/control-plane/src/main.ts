import * as NodeCrypto from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";

import * as BrowserSessionStore from "./BrowserSessionStore.ts";
import * as Database from "./Database.ts";
import * as IdentityQuery from "./IdentityQuery.ts";
import * as HostedWorkspaceAssertionIssuer from "./HostedWorkspaceAssertionIssuer.ts";
import * as IdentityRepository from "./IdentityRepository.ts";
import * as InvitationRepository from "./InvitationRepository.ts";
import * as KubernetesConfig from "./KubernetesConfig.ts";
import { runMigrations } from "./Migrations.ts";
import * as OidcConfig from "./OidcConfig.ts";
import * as OidcProvider from "./OidcProvider.ts";
import * as OrganizationAuthorization from "./OrganizationAuthorization.ts";
import * as OrganizationRepository from "./OrganizationRepository.ts";
import * as OutboxRepository from "./OutboxRepository.ts";
import { runOutboxWorker } from "./OutboxWorker.ts";
import * as Routes from "./Routes.ts";
import * as StorageQuery from "./StorageQuery.ts";
import * as WorkspaceAdmission from "./WorkspaceAdmission.ts";
import * as WorkspaceCatalog from "./WorkspaceCatalog.ts";
import * as WorkspaceProjection from "./WorkspaceProjection.ts";
import * as WorkspaceProxySession from "./WorkspaceProxySession.ts";
import * as WorkspaceQuery from "./WorkspaceQuery.ts";
import * as WorkspaceRepository from "./WorkspaceRepository.ts";
import * as WorkspaceResourcePublisher from "./WorkspaceResourcePublisher.ts";
import * as WorkspaceStatusRepository from "./WorkspaceStatusRepository.ts";
import { projectWorkspaceStatus } from "./WorkspaceStatusProjector.ts";
import { runWorkspaceStatusWatch } from "./WorkspaceStatusWatch.ts";
import * as WorkspaceVolumeRepository from "./WorkspaceVolumeRepository.ts";

const serverConfig = Config.all({
  host: Config.string("T3CODE_CONTROL_PLANE_HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.number("T3CODE_CONTROL_PLANE_PORT").pipe(Config.withDefault(3000)),
});

const PlatformLayer = NodeServices.layer;
const DatabaseLayer = Database.layer.pipe(Layer.provide(PlatformLayer));
const CatalogLayer = WorkspaceCatalog.layer.pipe(Layer.provide(PlatformLayer));
const KubernetesConfigLayer = KubernetesConfig.layer;
const OidcConfigLayer = OidcConfig.layer.pipe(Layer.provide(PlatformLayer));
const OidcProviderLayer = OidcProvider.layer.pipe(
  Layer.provide(Layer.merge(OidcConfigLayer, FetchHttpClient.layer)),
);
const ProjectionConfigLayer = WorkspaceProjection.configLayer;

const ServicesLayer = Layer.mergeAll(
  DatabaseLayer,
  CatalogLayer,
  KubernetesConfigLayer,
  OidcConfigLayer,
  OidcProviderLayer,
  ProjectionConfigLayer,
  BrowserSessionStore.layer.pipe(Layer.provide(DatabaseLayer)),
  HostedWorkspaceAssertionIssuer.layer.pipe(Layer.provide(NodeServices.layer)),
  IdentityQuery.layer.pipe(Layer.provide(DatabaseLayer)),
  IdentityRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  InvitationRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  OrganizationAuthorization.layer.pipe(Layer.provide(DatabaseLayer)),
  OrganizationRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  OutboxRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  StorageQuery.layer.pipe(Layer.provide(Layer.merge(DatabaseLayer, CatalogLayer))),
  WorkspaceAdmission.layer.pipe(Layer.provide(Layer.merge(DatabaseLayer, CatalogLayer))),
  WorkspaceProjection.layer.pipe(Layer.provide(Layer.merge(DatabaseLayer, ProjectionConfigLayer))),
  WorkspaceProxySession.sessionLayer.pipe(Layer.provide(NodeServices.layer)),
  WorkspaceProxySession.tokenExchangeLayer.pipe(
    Layer.provide(Layer.merge(ProjectionConfigLayer, FetchHttpClient.layer)),
  ),
  WorkspaceQuery.layer.pipe(Layer.provide(DatabaseLayer)),
  WorkspaceRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  WorkspaceResourcePublisher.layer.pipe(Layer.provide(KubernetesConfigLayer)),
  WorkspaceStatusRepository.layer.pipe(Layer.provide(DatabaseLayer)),
  WorkspaceVolumeRepository.layer.pipe(Layer.provide(DatabaseLayer)),
);

const HttpServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const server = yield* serverConfig;
    const [NodeHttpServer, NodeHttp] = yield* Effect.all([
      Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
      Effect.promise(() => import("node:http")),
    ]);
    return NodeHttpServer.layer(NodeHttp.createServer, {
      host: server.host,
      port: server.port,
    });
  }),
);

const ApplicationLayer = HttpRouter.serve(Routes.layer, {
  disableLogger: false,
}).pipe(Layer.provideMerge(HttpServerLayer), Layer.provideMerge(PlatformLayer));

class WorkspaceStatusWatchError extends Schema.TaggedErrorClass<WorkspaceStatusWatchError>()(
  "WorkspaceStatusWatchError",
  { cause: Schema.Defect() },
) {}

const runStatusProjection = Effect.gen(function* () {
  const context = yield* Effect.context<WorkspaceStatusRepository.WorkspaceStatusRepository>();
  const runPromise = Effect.runPromiseWith(context);
  const namespace = (yield* WorkspaceProjection.WorkspaceProjectionConfig).namespace;
  const kubeConfig = yield* KubernetesConfig.KubernetesConfig;
  return yield* Effect.callback<void, WorkspaceStatusWatchError>((resume) => {
    const controller = new AbortController();
    void runWorkspaceStatusWatch({
      namespace,
      kubeConfig,
      signal: controller.signal,
      project: (resource) => runPromise(projectWorkspaceStatus(resource).pipe(Effect.asVoid)),
    }).then(
      () => resume(Effect.void),
      (cause) => resume(Effect.fail(new WorkspaceStatusWatchError({ cause }))),
    );
    return Effect.sync(() => controller.abort());
  });
});

const program = Effect.gen(function* () {
  yield* runMigrations();
  yield* Effect.logInfo("Control-plane migrations are current.");
  yield* runOutboxWorker(NodeCrypto.randomUUID()).pipe(Effect.forkScoped);
  yield* runStatusProjection.pipe(Effect.forkScoped);
  return yield* Layer.launch(ApplicationLayer);
}).pipe(Effect.provide(Layer.merge(ServicesLayer, PlatformLayer)), Effect.scoped);

if (import.meta.main) NodeRuntime.runMain(program);
