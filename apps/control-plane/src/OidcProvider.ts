import { createRemoteJWKSet, jwtVerify } from "jose";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import * as OidcConfig from "./OidcConfig.ts";

const OidcDiscoveryDocument = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  token_endpoint_auth_methods_supported: Schema.optionalKey(Schema.Array(Schema.String)),
});

const OidcTokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Number),
  id_token: Schema.String,
});

export interface OidcIdentity {
  readonly issuer: string;
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly oidcSessionId?: string;
}

export class OidcProviderError extends Schema.TaggedErrorClass<OidcProviderError>()(
  "OidcProviderError",
  {
    reason: Schema.Literals([
      "discovery_failed",
      "issuer_mismatch",
      "token_exchange_failed",
      "token_response_invalid",
      "id_token_invalid",
      "nonce_mismatch",
      "subject_missing",
    ]),
    providerError: Schema.optionalKey(Schema.String),
    providerErrorDescription: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export class OidcProvider extends Context.Service<
  OidcProvider,
  {
    readonly authorizationUrl: (input: {
      readonly state: string;
      readonly nonce: string;
      readonly codeChallenge: string;
    }) => URL;
    readonly exchangeCode: (input: {
      readonly code: string;
      readonly verifier: string;
      readonly expectedNonce: string;
    }) => Effect.Effect<OidcIdentity, OidcProviderError>;
  }
>()("@t3tools/control-plane/OidcProvider") {}

export const make = Effect.gen(function* () {
  const config = yield* OidcConfig.OidcConfig;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const fetchJson = Effect.fn("OidcProvider.fetchJson")(function* (
    url: string,
    init:
      | {
          readonly method?: "GET" | "POST";
          readonly headers?: Record<string, string>;
          readonly body?: string;
        }
      | undefined,
    reason: "discovery_failed" | "token_exchange_failed",
  ) {
    const request = HttpClientRequest.make(init?.method ?? "GET")(url, {
      headers: init?.headers,
    }).pipe(
      init?.body === undefined
        ? (request) => request
        : HttpClientRequest.bodyText(
            init.body,
            init.headers?.["content-type"] ?? "application/json",
          ),
    );
    return yield* client.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
      Effect.mapError((cause) => new OidcProviderError({ reason, cause })),
    );
  });
  const discoveryUrl = new URL(
    ".well-known/openid-configuration",
    `${config.issuer.toString().replace(/\/$/, "")}/`,
  );
  const discoveryUnknown = yield* fetchJson(discoveryUrl.toString(), undefined, "discovery_failed");
  const discovery = yield* Schema.decodeUnknownEffect(OidcDiscoveryDocument)(discoveryUnknown).pipe(
    Effect.mapError((cause) => new OidcProviderError({ reason: "discovery_failed", cause })),
  );
  if (discovery.issuer !== config.issuer.toString().replace(/\/$/, "")) {
    return yield* new OidcProviderError({ reason: "issuer_mismatch" });
  }
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));

  const authorizationUrl: OidcProvider["Service"]["authorizationUrl"] = (input) => {
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  };

  const exchangeCode: OidcProvider["Service"]["exchangeCode"] = Effect.fn(
    "OidcProvider.exchangeCode",
  )(function* (input) {
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: config.redirectUri,
      code_verifier: input.verifier,
    });
    const supportedMethods = discovery.token_endpoint_auth_methods_supported ?? [];
    const useBasic =
      supportedMethods.length === 0 || supportedMethods.includes("client_secret_basic");
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
    };
    if (useBasic) {
      headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${Redacted.value(config.clientSecret)}`).toString("base64")}`;
    } else if (supportedMethods.includes("client_secret_post")) {
      form.set("client_id", config.clientId);
      form.set("client_secret", Redacted.value(config.clientSecret));
    } else {
      return yield* new OidcProviderError({ reason: "token_exchange_failed" });
    }
    const tokenRequest = HttpClientRequest.make("POST")(discovery.token_endpoint, { headers }).pipe(
      HttpClientRequest.bodyText(form.toString(), "application/x-www-form-urlencoded"),
    );
    const tokenResponse = yield* client.execute(tokenRequest).pipe(
      Effect.catch((cause) => {
        if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
          return Effect.succeed(cause.response);
        }
        return Effect.fail(new OidcProviderError({ reason: "token_exchange_failed", cause }));
      }),
    );
    const tokenUnknown = yield* tokenResponse.json.pipe(
      Effect.mapError((cause) => new OidcProviderError({ reason: "token_exchange_failed", cause })),
    );
    if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
      const providerError =
        typeof tokenUnknown === "object" &&
        tokenUnknown !== null &&
        "error" in tokenUnknown &&
        typeof tokenUnknown.error === "string"
          ? tokenUnknown.error
          : undefined;
      const providerErrorDescription =
        typeof tokenUnknown === "object" &&
        tokenUnknown !== null &&
        "error_description" in tokenUnknown &&
        typeof tokenUnknown.error_description === "string"
          ? tokenUnknown.error_description
          : undefined;
      return yield* new OidcProviderError({
        reason: "token_exchange_failed",
        ...(providerError === undefined ? {} : { providerError }),
        ...(providerErrorDescription === undefined ? {} : { providerErrorDescription }),
      });
    }
    const token = yield* Schema.decodeUnknownEffect(OidcTokenResponse)(tokenUnknown).pipe(
      Effect.mapError(
        (cause) => new OidcProviderError({ reason: "token_response_invalid", cause }),
      ),
    );
    const verified = yield* Effect.tryPromise({
      try: () =>
        jwtVerify(token.id_token, jwks, {
          issuer: discovery.issuer,
          audience: config.clientId,
        }),
      catch: (cause) => new OidcProviderError({ reason: "id_token_invalid", cause }),
    });
    if (verified.payload.nonce !== input.expectedNonce) {
      return yield* new OidcProviderError({ reason: "nonce_mismatch" });
    }
    if (typeof verified.payload.sub !== "string" || verified.payload.sub.length === 0) {
      return yield* new OidcProviderError({ reason: "subject_missing" });
    }
    return {
      issuer: discovery.issuer,
      subject: verified.payload.sub,
      ...(typeof verified.payload.email === "string" ? { email: verified.payload.email } : {}),
      ...(typeof verified.payload.email_verified === "boolean"
        ? { emailVerified: verified.payload.email_verified }
        : {}),
      ...(typeof verified.payload.name === "string" ? { displayName: verified.payload.name } : {}),
      ...(typeof verified.payload.picture === "string"
        ? { avatarUrl: verified.payload.picture }
        : {}),
      ...(typeof verified.payload.sid === "string" ? { oidcSessionId: verified.payload.sid } : {}),
    };
  });

  return OidcProvider.of({ authorizationUrl, exchangeCode });
});

export const layer = Layer.effect(OidcProvider, make);
