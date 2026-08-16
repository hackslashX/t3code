import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { decodeOidcTransactionKey } from "./OidcLogin.ts";

export class OidcConfigError extends Schema.TaggedErrorClass<OidcConfigError>()("OidcConfigError", {
  reason: Schema.Literals(["secret_read_failed", "secret_empty", "invalid_url", "invalid_key"]),
  path: Schema.optionalKey(Schema.String),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface OidcConfigValue {
  readonly issuer: URL;
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
  readonly publicBaseUrl: URL;
  readonly redirectUri: string;
  readonly transactionKey: Buffer;
}

export class OidcConfig extends Context.Service<OidcConfig, OidcConfigValue>()(
  "@t3tools/control-plane/OidcConfig",
) {}

const environment = Config.all({
  issuer: Config.string("T3CODE_CONTROL_PLANE_OIDC_ISSUER"),
  clientId: Config.string("T3CODE_CONTROL_PLANE_OIDC_CLIENT_ID"),
  clientSecretFile: Config.string("T3CODE_CONTROL_PLANE_OIDC_CLIENT_SECRET_FILE"),
  publicBaseUrl: Config.string("T3CODE_CONTROL_PLANE_PUBLIC_BASE_URL"),
  transactionKeyFile: Config.string("T3CODE_CONTROL_PLANE_OIDC_TRANSACTION_KEY_FILE"),
});

const readSecret = Effect.fn("OidcConfig.readSecret")(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const value = yield* fileSystem
    .readFileString(path)
    .pipe(
      Effect.mapError(
        (cause) => new OidcConfigError({ reason: "secret_read_failed", path, cause }),
      ),
    );
  const trimmed = value.trim();
  if (trimmed.length === 0) return yield* new OidcConfigError({ reason: "secret_empty", path });
  return trimmed;
});

const parseUrl = (value: string) =>
  Effect.try({
    try: () => new URL(value),
    catch: (cause) => new OidcConfigError({ reason: "invalid_url", cause }),
  }).pipe(
    Effect.filterOrFail(
      (url) => url.protocol === "https:" || url.hostname === "localhost",
      () => new OidcConfigError({ reason: "invalid_url" }),
    ),
  );

export const make = Effect.gen(function* () {
  const values = yield* environment;
  const issuer = yield* parseUrl(values.issuer);
  const publicBaseUrl = yield* parseUrl(values.publicBaseUrl);
  const clientSecret = yield* readSecret(values.clientSecretFile);
  const encodedTransactionKey = yield* readSecret(values.transactionKeyFile);
  const transactionKey = yield* Effect.try({
    try: () => decodeOidcTransactionKey(encodedTransactionKey),
    catch: (cause) => new OidcConfigError({ reason: "invalid_key", cause }),
  });
  const clientId = values.clientId.trim();
  if (clientId.length === 0) {
    return yield* new OidcConfigError({ reason: "secret_empty", path: "OIDC client ID" });
  }
  return OidcConfig.of({
    issuer,
    clientId,
    clientSecret: Redacted.make(clientSecret),
    publicBaseUrl,
    redirectUri: new URL("/auth/callback", publicBaseUrl).toString(),
    transactionKey,
  });
});

export const layer = Layer.effect(OidcConfig, make);
