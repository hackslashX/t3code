import { OrganizationId } from "@t3tools/hosted-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { OrganizationAuthorizationError } from "./OrganizationAuthorization.ts";
import * as OrganizationAuthorization from "./OrganizationAuthorization.ts";
import { authenticateRequest, RequestAuthenticationError } from "./RequestAuthentication.ts";
import { StorageQueryError } from "./StorageQuery.ts";
import * as StorageQuery from "./StorageQuery.ts";

const headers = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const errorResponse = (error: string, status: 401 | 403 | 404 | 500) =>
  HttpServerResponse.jsonUnsafe({ error }, { status, headers });

const listStorageOptionsRoute = HttpRouter.add(
  "GET",
  "/api/organizations/:organizationId/storage-options",
  Effect.gen(function* () {
    const organizationIdRaw = (yield* HttpRouter.params).organizationId;
    if (organizationIdRaw === undefined || !uuidPattern.test(organizationIdRaw)) {
      return errorResponse("organization_not_found", 404);
    }
    const organizationId = OrganizationId.make(organizationIdRaw);
    const authenticated = yield* authenticateRequest();
    const authorization = yield* OrganizationAuthorization.OrganizationAuthorization;
    yield* authorization.authorize(authenticated.principalId, organizationId, "storage.read");
    const query = yield* StorageQuery.StorageQuery;
    return HttpServerResponse.jsonUnsafe(yield* query.listOptions(organizationId), { headers });
  }).pipe(
    Effect.catch(
      (error: RequestAuthenticationError | OrganizationAuthorizationError | StorageQueryError) => {
        if (Schema.is(RequestAuthenticationError)(error)) {
          return Effect.succeed(errorResponse("authentication_required", 401));
        }
        if (Schema.is(OrganizationAuthorizationError)(error) && error.reason === "access_denied") {
          return Effect.succeed(errorResponse("access_denied", 403));
        }
        return Effect.succeed(errorResponse("internal_error", 500));
      },
    ),
    Effect.catchCause(() => Effect.succeed(errorResponse("internal_error", 500))),
  ),
);

export const layer = listStorageOptionsRoute;
