import {
  CreateWorkspaceRequest,
  DeleteWorkspaceRequest,
  MigrateWorkspaceRequest,
  OrganizationId,
  UpdateWorkspaceDesiredStateRequest,
  WorkspaceId,
  WorkspaceVolumeId,
} from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { HostedWorkspaceAssertionIssuerError } from "./HostedWorkspaceAssertionIssuer.ts";
import * as HostedWorkspaceAssertionIssuer from "./HostedWorkspaceAssertionIssuer.ts";
import * as OidcConfig from "./OidcConfig.ts";
import { BROWSER_SESSION_COOKIE } from "./AuthCookies.ts";
import { OrganizationAuthorizationError } from "./OrganizationAuthorization.ts";
import * as OrganizationAuthorization from "./OrganizationAuthorization.ts";
import {
  authenticateMutationRequest,
  authenticateRequest,
  RequestAuthenticationError,
} from "./RequestAuthentication.ts";
import { WorkspaceAdmissionError } from "./WorkspaceAdmission.ts";
import * as WorkspaceAdmission from "./WorkspaceAdmission.ts";
import { WorkspacePolicyRejectedError, validateWorkspaceCreate } from "./workspacePolicy.ts";
import { WorkspaceProxySessionError } from "./WorkspaceProxySession.ts";
import * as WorkspaceProxySession from "./WorkspaceProxySession.ts";
import { WorkspaceProxyGrantError } from "./WorkspaceProxyGrantStore.ts";
import * as WorkspaceProxyGrantStore from "./WorkspaceProxyGrantStore.ts";
import { WorkspaceQueryError } from "./WorkspaceQuery.ts";
import * as WorkspaceQuery from "./WorkspaceQuery.ts";
import { WorkspaceRepositoryError } from "./WorkspaceRepository.ts";
import * as WorkspaceRepository from "./WorkspaceRepository.ts";

const headers = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorResponse = (error: string, status: 400 | 401 | 403 | 404 | 409 | 500) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers });

type RouteError =
  | RequestAuthenticationError
  | OrganizationAuthorizationError
  | WorkspaceAdmissionError
  | WorkspacePolicyRejectedError
  | WorkspaceRepositoryError
  | WorkspaceQueryError
  | Schema.SchemaError
  | HostedWorkspaceAssertionIssuerError
  | WorkspaceProxySessionError
  | WorkspaceProxyGrantError
  | Cookies.CookiesError
  | HttpServerError.HttpServerError;

const mapErrors = <R>(
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, RouteError, R>,
) =>
  effect.pipe(
    Effect.catch((error) => {
      if (Schema.is(RequestAuthenticationError)(error)) {
        return Effect.succeed(
          errorResponse(error.reason, error.reason === "origin_forbidden" ? 403 : 401),
        );
      }
      if (Schema.is(OrganizationAuthorizationError)(error)) {
        return Effect.succeed(
          errorResponse(
            error.reason === "access_denied" ? "access_denied" : "internal_error",
            error.reason === "access_denied" ? 403 : 500,
          ),
        );
      }
      if (Schema.is(WorkspacePolicyRejectedError)(error))
        return Effect.succeed(errorResponse(error.reason, 409));
      if (Schema.is(WorkspaceRepositoryError)(error)) {
        if (error.reason === "workspace_not_found")
          return Effect.succeed(errorResponse(error.reason, 404));
        if (error.reason === "persistence_failed")
          return Effect.succeed(errorResponse("internal_error", 500));
        return Effect.succeed(errorResponse(error.reason, 409));
      }
      if (
        Schema.is(HostedWorkspaceAssertionIssuerError)(error) ||
        Schema.is(WorkspaceProxySessionError)(error)
      )
        return Effect.succeed(errorResponse("internal_error", 500));
      if (Schema.is(WorkspaceProxyGrantError)(error))
        return Effect.succeed(
          errorResponse(
            error.reason === "invalid_grant" ? "authentication_required" : "internal_error",
            error.reason === "invalid_grant" ? 401 : 500,
          ),
        );
      if (Schema.is(WorkspaceQueryError)(error))
        return Effect.succeed(
          errorResponse(
            error.reason === "workspace_not_found" ? error.reason : "internal_error",
            error.reason === "workspace_not_found" ? 404 : 500,
          ),
        );
      if (Schema.is(WorkspaceAdmissionError)(error))
        return Effect.succeed(
          errorResponse(
            error.reason === "organization_quota_missing" ? error.reason : "internal_error",
            error.reason === "organization_quota_missing" ? 409 : 500,
          ),
        );
      if (error instanceof Schema.SchemaError || HttpServerError.isHttpServerError(error))
        return Effect.succeed(errorResponse("invalid_request", 400));
      return Effect.succeed(errorResponse("internal_error", 500));
    }),
    Effect.catchCause(() => Effect.succeed(errorResponse("internal_error", 500))),
  );

const organizationParam = Effect.gen(function* () {
  const value = (yield* HttpRouter.params).organizationId;
  return value === undefined || !uuidPattern.test(value) ? undefined : OrganizationId.make(value);
});
const requestId = (request: HttpServerRequest.HttpServerRequest) =>
  request.headers["x-request-id"]?.trim().slice(0, 200) || NodeCrypto.randomUUID();
const makeSlug = (name: string, workspaceId: string) => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "workspace";
  return `${base}-${workspaceId.slice(0, 8)}`;
};

const listRoute = HttpRouter.add(
  "GET",
  "/api/organizations/:organizationId/workspaces",
  mapErrors(
    Effect.gen(function* () {
      const organizationId = yield* organizationParam;
      if (organizationId === undefined) return errorResponse("organization_not_found", 404);
      const authenticated = yield* authenticateRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.read",
      );
      const workspaces = yield* (yield* WorkspaceQuery.WorkspaceQuery).list(organizationId);
      return HttpServerResponse.jsonUnsafe({ workspaces }, { headers });
    }),
  ),
);

const getRoute = HttpRouter.add(
  "GET",
  "/api/organizations/:organizationId/workspaces/:workspaceId",
  mapErrors(
    Effect.gen(function* () {
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      )
        return errorResponse("workspace_not_found", 404);
      const authenticated = yield* authenticateRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.read",
      );
      const workspace = yield* (yield* WorkspaceQuery.WorkspaceQuery).get(
        organizationId,
        WorkspaceId.make(params.workspaceId),
      );
      return HttpServerResponse.jsonUnsafe({ workspace }, { headers });
    }),
  ),
);

const createRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/workspaces",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const organizationId = yield* organizationParam;
      if (organizationId === undefined) return errorResponse("organization_not_found", 404);
      const authenticated = yield* authenticateMutationRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.create",
      );
      const input = yield* Schema.decodeUnknownEffect(CreateWorkspaceRequest)(yield* request.json);
      yield* validateWorkspaceCreate(
        input,
        yield* (yield* WorkspaceAdmission.WorkspaceAdmission).load(organizationId),
      );
      const workspaceId = WorkspaceId.make(NodeCrypto.randomUUID());
      yield* (yield* WorkspaceRepository.WorkspaceRepository).create({
        workspaceId,
        organizationId,
        ownerPrincipalId: authenticated.principalId,
        slug: makeSlug(input.name, workspaceId),
        request: input,
        volumeId: WorkspaceVolumeId.make(NodeCrypto.randomUUID()),
        requestId: requestId(request),
      });
      const workspace = yield* (yield* WorkspaceQuery.WorkspaceQuery).get(
        organizationId,
        workspaceId,
      );
      return HttpServerResponse.jsonUnsafe({ workspace }, { status: 201, headers });
    }),
  ),
);

const migrateImageRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/workspaces/:workspaceId/migrate-image",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      )
        return errorResponse("workspace_not_found", 404);
      const authenticated = yield* authenticateMutationRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.update",
      );
      const input = yield* Schema.decodeUnknownEffect(MigrateWorkspaceRequest)(yield* request.json);
      const result = yield* (yield* WorkspaceRepository.WorkspaceRepository).migrateImage(
        WorkspaceId.make(params.workspaceId),
        organizationId,
        authenticated.principalId,
        requestId(request),
        input.expectedGeneration,
      );
      return HttpServerResponse.jsonUnsafe(result, { headers });
    }),
  ),
);

const desiredStateRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/workspaces/:workspaceId/desired-state",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      )
        return errorResponse("workspace_not_found", 404);
      const authenticated = yield* authenticateMutationRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.update",
      );
      const input = yield* Schema.decodeUnknownEffect(UpdateWorkspaceDesiredStateRequest)(
        yield* request.json,
      );
      const result = yield* (yield* WorkspaceRepository.WorkspaceRepository).updateDesiredState(
        WorkspaceId.make(params.workspaceId),
        organizationId,
        authenticated.principalId,
        requestId(request),
        input,
      );
      return HttpServerResponse.jsonUnsafe(result, { headers });
    }),
  ),
);

const accessAssertionRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/workspaces/:workspaceId/access-assertion",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      ) {
        return errorResponse("workspace_not_found", 404);
      }
      const authenticated = yield* authenticateMutationRequest();
      const role = yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.read",
      );
      const workspaceId = WorkspaceId.make(params.workspaceId);
      const workspace = yield* (yield* WorkspaceQuery.WorkspaceQuery).get(
        organizationId,
        workspaceId,
      );
      if (workspace.phase !== "Ready" || workspace.environmentId === undefined) {
        return errorResponse("workspace_not_ready", 409);
      }
      const result =
        yield* (yield* HostedWorkspaceAssertionIssuer.HostedWorkspaceAssertionIssuer).issue({
          principalId: authenticated.principalId,
          organizationId,
          organizationRole: role,
          workspaceId,
          environmentId: workspace.environmentId,
        });
      return HttpServerResponse.jsonUnsafe(result, { headers });
    }),
  ),
);

const proxySessionRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/workspaces/:workspaceId/proxy-session",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      ) {
        return errorResponse("workspace_not_found", 404);
      }
      const authenticated = yield* authenticateMutationRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.read",
      );
      const workspaceId = WorkspaceId.make(params.workspaceId);
      const workspace = yield* (yield* WorkspaceQuery.WorkspaceQuery).get(
        organizationId,
        workspaceId,
      );
      if (workspace.phase !== "Ready" || workspace.environmentId === undefined) {
        return errorResponse("workspace_not_ready", 409);
      }
      const browserSessionToken = request.cookies[BROWSER_SESSION_COOKIE];
      if (browserSessionToken === undefined) return errorResponse("authentication_required", 401);
      const grant = yield* (yield* WorkspaceProxyGrantStore.WorkspaceProxyGrantStore).issue({
        browserSessionToken,
        principalId: authenticated.principalId,
        organizationId,
        workspaceId,
      });
      const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
      // This cookie is only an opaque grant handle. The proxy fetches short-lived T3
      // credentials itself, so no upstream bearer token survives browser logout.
      const expiresAtEpochSeconds = now + 28_800;
      const proxySessions = yield* WorkspaceProxySession.WorkspaceProxySession;
      const sealed = proxySessions.seal({
        workspaceId,
        credential: grant.credential,
        expiresAtEpochSeconds,
      });
      const publicConfig = yield* OidcConfig.OidcConfig;
      const cookies = yield* Effect.fromResult(
        Cookies.set(Cookies.empty, WorkspaceProxySession.WORKSPACE_PROXY_SESSION_COOKIE, sealed, {
          httpOnly: true,
          secure: publicConfig.publicBaseUrl.protocol === "https:",
          sameSite: "lax",
          domain: proxySessions.cookieDomain,
          path: "/",
          expires: DateTime.toDate(DateTime.makeUnsafe(expiresAtEpochSeconds * 1_000)),
        }),
      );
      return HttpServerResponse.jsonUnsafe(
        {
          workspaceId,
          expiresAtEpochSeconds,
          t3Url: `https://t3-${workspaceId}.${proxySessions.hostSuffix}/`,
          codeServerUrl: `https://code-${workspaceId}.${proxySessions.hostSuffix}/`,
        },
        { headers, cookies },
      );
    }),
  ),
);

const ProxyLeaseRequest = Schema.Struct({
  credential: Schema.String,
  workspaceId: WorkspaceId,
});

const proxyLeaseRoute = HttpRouter.add(
  "POST",
  "/internal/workspace-proxy/lease",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const input = yield* Schema.decodeUnknownEffect(ProxyLeaseRequest)(yield* request.json);
      const signature = request.headers["x-t3-workspace-proxy-signature"];
      const session = yield* WorkspaceProxySession.WorkspaceProxySession;
      const expected = NodeCrypto.createHmac("sha256", session.key)
        .update(`${input.workspaceId}:${input.credential}`)
        .digest("base64url");
      if (
        signature === undefined ||
        signature.length !== expected.length ||
        !NodeCrypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        return errorResponse("authentication_required", 401);
      }
      const grant = yield* (yield* WorkspaceProxyGrantStore.WorkspaceProxyGrantStore).verify(
        input.credential,
        input.workspaceId,
      );
      const role = yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        grant.principalId,
        grant.organizationId,
        "workspace.read",
      );
      const workspace = yield* (yield* WorkspaceQuery.WorkspaceQuery).get(
        grant.organizationId,
        grant.workspaceId,
      );
      if (workspace.phase !== "Ready" || workspace.environmentId === undefined) {
        return errorResponse("workspace_not_ready", 409);
      }
      const assertion = yield* (yield* HostedWorkspaceAssertionIssuer.HostedWorkspaceAssertionIssuer).issue({
        principalId: grant.principalId,
        organizationId: grant.organizationId,
        organizationRole: role,
        workspaceId: grant.workspaceId,
        environmentId: workspace.environmentId,
      });
      const exchanged = yield* (yield* WorkspaceProxySession.WorkspaceTokenExchange).exchange(
        grant.workspaceId,
        assertion.assertion,
      );
      return HttpServerResponse.jsonUnsafe(
        { accessToken: exchanged.accessToken, expiresInSeconds: exchanged.expiresInSeconds },
        { headers },
      );
    }),
  ),
);

const deleteRoute = HttpRouter.add(
  "DELETE",
  "/api/organizations/:organizationId/workspaces/:workspaceId",
  mapErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationId = yield* organizationParam;
      if (
        organizationId === undefined ||
        params.workspaceId === undefined ||
        !uuidPattern.test(params.workspaceId)
      ) {
        return errorResponse("workspace_not_found", 404);
      }
      const authenticated = yield* authenticateMutationRequest();
      yield* (yield* OrganizationAuthorization.OrganizationAuthorization).authorize(
        authenticated.principalId,
        organizationId,
        "workspace.delete",
      );
      const input = yield* Schema.decodeUnknownEffect(DeleteWorkspaceRequest)(yield* request.json);
      const result = yield* (yield* WorkspaceRepository.WorkspaceRepository).delete(
        WorkspaceId.make(params.workspaceId),
        organizationId,
        authenticated.principalId,
        requestId(request),
        input,
      );
      return HttpServerResponse.jsonUnsafe(result, { status: 202, headers });
    }),
  ),
);

export const layer = Layer.mergeAll(
  listRoute,
  getRoute,
  createRoute,
  migrateImageRoute,
  desiredStateRoute,
  accessAssertionRoute,
  proxySessionRoute,
  proxyLeaseRoute,
  deleteRoute,
);
