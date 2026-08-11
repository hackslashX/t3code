import { PrincipalId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { BROWSER_SESSION_COOKIE, LOGIN_TRANSACTION_COOKIE } from "./AuthCookies.ts";
import * as BrowserSessionStore from "./BrowserSessionStore.ts";
import * as IdentityRepository from "./IdentityRepository.ts";
import * as OidcConfig from "./OidcConfig.ts";
import {
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  OidcLoginTransactionError,
} from "./OidcLogin.ts";
import * as OidcProvider from "./OidcProvider.ts";

const noStoreHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const safeError = (message: string, status: 400 | 401 | 403 | 500 = 400) =>
  HttpServerResponse.jsonUnsafe({ error: message }, { status, headers: noStoreHeaders });

const cookieOptions = (secure: boolean) => ({
  httpOnly: true,
  path: "/",
  sameSite: "lax" as const,
  secure,
});

const setCookie = Effect.fn("HostedAuthRoutes.setCookie")(function* (
  name: string,
  value: string,
  options: Cookies.Cookie["options"],
) {
  return yield* Effect.fromResult(Cookies.set(Cookies.empty, name, value, options));
});

const loginRoute = HttpRouter.add(
  "GET",
  "/auth/login",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* OidcConfig.OidcConfig;
    const provider = yield* OidcProvider.OidcProvider;
    const requestUrl = new URL(request.originalUrl, config.publicBaseUrl);
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const invitationToken = requestUrl.searchParams.get("invitation_token");
    const transaction = createOidcLoginTransaction({
      key: config.transactionKey,
      returnTo: requestUrl.searchParams.get("return_to") ?? "/",
      nowEpochSeconds: now,
      ...(invitationToken === null ? {} : { invitationToken }),
    });
    const cookies = yield* setCookie(LOGIN_TRANSACTION_COOKIE, transaction.encryptedTransaction, {
      ...cookieOptions(config.publicBaseUrl.protocol === "https:"),
      maxAge: "10 minutes",
    });
    return HttpServerResponse.redirect(provider.authorizationUrl(transaction).toString(), {
      status: 302,
      cookies,
      headers: noStoreHeaders,
    });
  }).pipe(Effect.catchCause(() => Effect.succeed(safeError("login_failed", 500)))),
);

const callbackRoute = HttpRouter.add(
  "GET",
  "/auth/callback",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* OidcConfig.OidcConfig;
    const provider = yield* OidcProvider.OidcProvider;
    const identities = yield* IdentityRepository.IdentityRepository;
    const sessions = yield* BrowserSessionStore.BrowserSessionStore;
    const requestUrl = new URL(request.originalUrl, config.publicBaseUrl);
    const code = requestUrl.searchParams.get("code");
    const state = requestUrl.searchParams.get("state");
    const encryptedTransaction = request.cookies[LOGIN_TRANSACTION_COOKIE];
    if (requestUrl.searchParams.has("error") || code === null || state === null) {
      return safeError("authorization_rejected", 401);
    }
    if (encryptedTransaction === undefined) return safeError("login_transaction_missing", 401);
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const transaction = yield* Effect.try({
      try: () =>
        consumeOidcLoginTransaction({
          key: config.transactionKey,
          encryptedTransaction,
          returnedState: state,
          nowEpochSeconds: now,
        }),
      catch: (cause) =>
        Schema.is(OidcLoginTransactionError)(cause)
          ? cause
          : new OidcLoginTransactionError({ reason: "malformed_transaction" }),
    });
    const identity = yield* provider.exchangeCode({
      code,
      verifier: transaction.verifier,
      expectedNonce: transaction.nonce,
    });
    const resolved = yield* identities
      .resolveOrEnroll({
        identity,
        ...(transaction.invitationToken === undefined
          ? {}
          : { invitationToken: transaction.invitationToken }),
        principalId: PrincipalId.make(NodeCrypto.randomUUID()),
        externalIdentityId: NodeCrypto.randomUUID(),
        requestId: NodeCrypto.randomUUID(),
      })
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning("OIDC enrollment rejected", {
            reason: error.reason,
            hasInvitationToken: transaction.invitationToken !== undefined,
            hasVerifiedEmail: identity.emailVerified !== false && identity.email !== undefined,
          }),
        ),
      );
    const session = yield* sessions.issue(resolved.principalId, {
      ...(identity.oidcSessionId === undefined ? {} : { oidcSessionId: identity.oidcSessionId }),
    });
    const secure = config.publicBaseUrl.protocol === "https:";
    const sessionCookies = yield* setCookie(BROWSER_SESSION_COOKIE, session.token, {
      ...cookieOptions(secure),
      expires: session.expiresAt,
    });
    const clearedTransaction = yield* setCookie(LOGIN_TRANSACTION_COOKIE, "", {
      ...cookieOptions(secure),
      maxAge: 0,
    });
    return HttpServerResponse.redirect(
      new URL(transaction.returnTo, config.publicBaseUrl).toString(),
      {
        status: 303,
        cookies: Cookies.merge(sessionCookies, clearedTransaction),
        headers: noStoreHeaders,
      },
    );
  }).pipe(
    Effect.catchTags({
      OidcLoginTransactionError: (error) =>
        Effect.logWarning("OIDC login transaction rejected", { reason: error.reason }).pipe(
          Effect.as(safeError("authentication_failed", 401)),
        ),
      OidcProviderError: (error) =>
        Effect.logWarning("OIDC provider authentication failed", {
          reason: error.reason,
          ...(error.providerError === undefined ? {} : { providerError: error.providerError }),
          ...(error.providerErrorDescription === undefined
            ? {}
            : { providerErrorDescription: error.providerErrorDescription }),
        }).pipe(Effect.as(safeError("authentication_failed", 401))),
      IdentityRepositoryError: (error) =>
        Effect.logWarning("OIDC identity resolution failed", { reason: error.reason }).pipe(
          Effect.as(safeError("authentication_failed", 401)),
        ),
      BrowserSessionError: (error) =>
        Effect.logWarning("browser session issuance failed", { reason: error.reason }).pipe(
          Effect.as(safeError("authentication_failed", 401)),
        ),
    }),
    Effect.catchCause(() => Effect.succeed(safeError("authentication_failed", 401))),
  ),
);

const logoutRoute = HttpRouter.add(
  "POST",
  "/auth/logout",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* OidcConfig.OidcConfig;
    const sessions = yield* BrowserSessionStore.BrowserSessionStore;
    const origin = request.headers.origin;
    if (origin === undefined || origin !== config.publicBaseUrl.origin) {
      return safeError("origin_forbidden", 403);
    }
    const token = request.cookies[BROWSER_SESSION_COOKIE];
    if (token !== undefined) yield* sessions.revoke(token);
    const cookies = yield* setCookie(BROWSER_SESSION_COOKIE, "", {
      ...cookieOptions(config.publicBaseUrl.protocol === "https:"),
      maxAge: 0,
    });
    return HttpServerResponse.empty({ status: 204, cookies, headers: noStoreHeaders });
  }).pipe(Effect.catchCause(() => Effect.succeed(safeError("logout_failed", 500)))),
);

export const layer = Layer.mergeAll(loginRoute, callbackRoute, logoutRoute);
