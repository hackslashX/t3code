import type { PrincipalId } from "@t3tools/hosted-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";

import { BROWSER_SESSION_COOKIE } from "./AuthCookies.ts";
import * as BrowserSessionStore from "./BrowserSessionStore.ts";
import * as OidcConfig from "./OidcConfig.ts";

export class RequestAuthenticationError extends Schema.TaggedErrorClass<RequestAuthenticationError>()(
  "RequestAuthenticationError",
  {
    reason: Schema.Literals(["authentication_required", "origin_forbidden"]),
  },
) {}

export interface AuthenticatedRequest {
  readonly principalId: PrincipalId;
}

export const isAllowedMutationOrigin = (origin: string | undefined, expectedOrigin: string) =>
  origin !== undefined && origin === expectedOrigin;

export const authenticateRequest = Effect.fn("RequestAuthentication.authenticate")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const sessions = yield* BrowserSessionStore.BrowserSessionStore;
  const token = request.cookies[BROWSER_SESSION_COOKIE];
  if (token === undefined) {
    return yield* new RequestAuthenticationError({ reason: "authentication_required" });
  }
  const session = yield* sessions
    .verify(token)
    .pipe(
      Effect.mapError(() => new RequestAuthenticationError({ reason: "authentication_required" })),
    );
  return { principalId: session.principalId } satisfies AuthenticatedRequest;
});

export const authenticateMutationRequest = Effect.fn("RequestAuthentication.authenticateMutation")(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* OidcConfig.OidcConfig;
    if (!isAllowedMutationOrigin(request.headers.origin, config.publicBaseUrl.origin)) {
      return yield* new RequestAuthenticationError({ reason: "origin_forbidden" });
    }
    return yield* authenticateRequest();
  },
);
