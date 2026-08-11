import {
  CreateOrganizationInvitationRequest,
  OrganizationId,
  RenameOrganizationRequest,
} from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Layer from "effect/Layer";

import { InvitationRepositoryError } from "./InvitationRepository.ts";
import * as InvitationRepository from "./InvitationRepository.ts";
import { OrganizationAuthorizationError } from "./OrganizationAuthorization.ts";
import * as OrganizationAuthorization from "./OrganizationAuthorization.ts";
import { OrganizationRepositoryError } from "./OrganizationRepository.ts";
import * as OrganizationRepository from "./OrganizationRepository.ts";
import {
  authenticateMutationRequest,
  RequestAuthenticationError,
} from "./RequestAuthentication.ts";

const headers = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;

const errorResponse = (error: string, status: 400 | 401 | 403 | 404 | 409 | 500) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers });

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const requestId = (request: HttpServerRequest.HttpServerRequest) => {
  const supplied = request.headers["x-request-id"]?.trim();
  return supplied === undefined || supplied.length === 0 || supplied.length > 200
    ? NodeCrypto.randomUUID()
    : supplied;
};

type RouteError =
  | RequestAuthenticationError
  | OrganizationAuthorizationError
  | InvitationRepositoryError
  | OrganizationRepositoryError
  | Schema.SchemaError
  | HttpServerError.HttpServerError;

const mapRouteErrors = <R>(
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
      if (Schema.is(InvitationRepositoryError)(error)) {
        switch (error.reason) {
          case "invalid_email":
          case "invalid_expiry":
            return Effect.succeed(errorResponse(error.reason, 400));
          case "invitation_not_found":
            return Effect.succeed(errorResponse(error.reason, 404));
          case "persistence_failed":
            return Effect.succeed(errorResponse("internal_error", 500));
        }
      }
      if (Schema.is(OrganizationRepositoryError)(error)) {
        return Effect.succeed(
          errorResponse(
            error.reason === "organization_not_found" ? "organization_not_found" : "internal_error",
            error.reason === "organization_not_found" ? 404 : 500,
          ),
        );
      }
      if (error instanceof Schema.SchemaError || HttpServerError.isHttpServerError(error)) {
        return Effect.succeed(errorResponse("invalid_request", 400));
      }
      return Effect.succeed(errorResponse("internal_error", 500));
    }),
    Effect.catchCause(() => Effect.succeed(errorResponse("internal_error", 500))),
  );

const createInvitationRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/invitations",
  mapRouteErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      const organizationIdRaw = params.organizationId;
      if (organizationIdRaw === undefined || !uuidPattern.test(organizationIdRaw)) {
        return errorResponse("organization_not_found", 404);
      }
      const organizationId = OrganizationId.make(organizationIdRaw);
      const authenticated = yield* authenticateMutationRequest();
      const authorization = yield* OrganizationAuthorization.OrganizationAuthorization;
      yield* authorization.authorize(
        authenticated.principalId,
        organizationId,
        "invitation.manage",
      );
      const body = yield* request.json;
      const input = yield* Schema.decodeUnknownEffect(CreateOrganizationInvitationRequest)(body);
      const invitations = yield* InvitationRepository.InvitationRepository;
      const invitationId = NodeCrypto.randomUUID();
      const invitation = yield* invitations.create({
        invitationId,
        organizationId,
        email: input.email,
        role: input.role,
        invitedByPrincipalId: authenticated.principalId,
        ...(input.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: input.expiresInSeconds }),
        requestId: requestId(request),
      });
      return HttpServerResponse.jsonUnsafe(
        {
          invitationId,
          token: invitation.token,
          expiresAt: invitation.expiresAt.toISOString(),
        },
        { status: 201, headers },
      );
    }),
  ),
);

const revokeInvitationRoute = HttpRouter.add(
  "POST",
  "/api/organizations/:organizationId/invitations/:invitationId/revoke",
  mapRouteErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      if (
        params.organizationId === undefined ||
        params.invitationId === undefined ||
        !uuidPattern.test(params.organizationId) ||
        !uuidPattern.test(params.invitationId)
      ) {
        return errorResponse("invitation_not_found", 404);
      }
      const organizationId = OrganizationId.make(params.organizationId);
      const authenticated = yield* authenticateMutationRequest();
      const authorization = yield* OrganizationAuthorization.OrganizationAuthorization;
      yield* authorization.authorize(
        authenticated.principalId,
        organizationId,
        "invitation.manage",
      );
      const invitations = yield* InvitationRepository.InvitationRepository;
      yield* invitations.revoke(
        params.invitationId,
        organizationId,
        authenticated.principalId,
        requestId(request),
      );
      return HttpServerResponse.empty({ status: 204, headers });
    }),
  ),
);

const renameOrganizationRoute = HttpRouter.add(
  "PATCH",
  "/api/organizations/:organizationId",
  mapRouteErrors(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const params = yield* HttpRouter.params;
      if (params.organizationId === undefined || !uuidPattern.test(params.organizationId)) {
        return errorResponse("organization_not_found", 404);
      }
      const organizationId = OrganizationId.make(params.organizationId);
      const authenticated = yield* authenticateMutationRequest();
      const authorization = yield* OrganizationAuthorization.OrganizationAuthorization;
      yield* authorization.authorize(
        authenticated.principalId,
        organizationId,
        "organization.manage",
      );
      const input = yield* Schema.decodeUnknownEffect(RenameOrganizationRequest)(
        yield* request.json,
      );
      const organizations = yield* OrganizationRepository.OrganizationRepository;
      yield* organizations.rename(
        organizationId,
        input.name,
        authenticated.principalId,
        requestId(request),
      );
      return HttpServerResponse.jsonUnsafe({ organizationId, name: input.name }, { headers });
    }),
  ),
);

export const layer = Layer.mergeAll(
  createInvitationRoute,
  revokeInvitationRoute,
  renameOrganizationRoute,
);
