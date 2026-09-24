import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as IdentityQuery from "./IdentityQuery.ts";
import { authenticateRequest, RequestAuthenticationError } from "./RequestAuthentication.ts";

const headers = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
} as const;

const meRoute = HttpRouter.add(
  "GET",
  "/api/me",
  Effect.gen(function* () {
    const authenticated = yield* authenticateRequest();
    const identities = yield* IdentityQuery.IdentityQuery;
    return HttpServerResponse.jsonUnsafe(yield* identities.get(authenticated.principalId), {
      headers,
    });
  }).pipe(
    Effect.catchTag("RequestAuthenticationError", (error: RequestAuthenticationError) =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe(
          { error: error.reason },
          { status: error.reason === "origin_forbidden" ? 403 : 401, headers },
        ),
      ),
    ),
    Effect.catchCause(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500, headers }),
      ),
    ),
  ),
);

export const layer = meRoute;
