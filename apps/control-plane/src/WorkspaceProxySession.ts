import { WorkspaceId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as WorkspaceProjection from "./WorkspaceProjection.ts";

export const WORKSPACE_PROXY_SESSION_COOKIE = "t3_hosted_workspace";
const AAD = Buffer.from("t3-hosted-workspace-proxy-session-v1");

const ProxySessionClaims = Schema.Struct({
  workspaceId: WorkspaceId,
  credential: Schema.String,
  expiresAtEpochSeconds: Schema.Int,
});
export type ProxySessionClaims = typeof ProxySessionClaims.Type;

const ExchangeResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

export class WorkspaceProxySessionError extends Schema.TaggedErrorClass<WorkspaceProxySessionError>()(
  "WorkspaceProxySessionError",
  {
    reason: Schema.Literals([
      "invalid_key",
      "invalid_config",
      "invalid_session",
      "session_expired",
      "token_exchange_failed",
      "token_response_invalid",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export const sealWorkspaceProxySession = (key: Buffer, claims: ProxySessionClaims) => {
  if (key.length !== 32) throw new WorkspaceProxySessionError({ reason: "invalid_key" });
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
};

export const openWorkspaceProxySession = (
  key: Buffer,
  value: string,
  nowEpochSeconds: number,
): ProxySessionClaims => {
  try {
    if (key.length !== 32) throw new WorkspaceProxySessionError({ reason: "invalid_key" });
    const packed = Buffer.from(value, "base64url");
    if (packed.length < 29) throw new WorkspaceProxySessionError({ reason: "invalid_session" });
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12));
    decipher.setAAD(AAD);
    decipher.setAuthTag(packed.subarray(12, 28));
    const claims = Schema.decodeUnknownSync(ProxySessionClaims)(
      JSON.parse(
        Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8"),
      ),
    );
    if (claims.expiresAtEpochSeconds <= nowEpochSeconds) {
      throw new WorkspaceProxySessionError({ reason: "session_expired" });
    }
    return claims;
  } catch (cause) {
    if (Schema.is(WorkspaceProxySessionError)(cause)) throw cause;
    throw new WorkspaceProxySessionError({ reason: "invalid_session", cause });
  }
};

export class WorkspaceProxySession extends Context.Service<
  WorkspaceProxySession,
  {
    readonly key: Buffer;
    readonly hostSuffix: string;
    readonly cookieDomain: string;
    readonly seal: (claims: ProxySessionClaims) => string;
  }
>()("@t3tools/control-plane/WorkspaceProxySession") {}

export class WorkspaceTokenExchange extends Context.Service<
  WorkspaceTokenExchange,
  {
    readonly exchange: (
      workspaceId: WorkspaceId,
      assertion: string,
    ) => Effect.Effect<
      { readonly accessToken: string; readonly expiresInSeconds: number },
      WorkspaceProxySessionError
    >;
  }
>()("@t3tools/control-plane/WorkspaceProxySession/WorkspaceTokenExchange") {}

const sessionConfig = Config.all({
  keyFile: Config.string("T3CODE_WORKSPACE_PROXY_SESSION_KEY_FILE"),
  hostSuffix: Config.string("T3CODE_WORKSPACE_PROXY_HOST_SUFFIX"),
  cookieDomain: Config.string("T3CODE_WORKSPACE_PROXY_COOKIE_DOMAIN"),
});

export const sessionLayer = Layer.effect(
  WorkspaceProxySession,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* sessionConfig;
    const encoded = yield* fileSystem
      .readFileString(config.keyFile)
      .pipe(
        Effect.mapError(
          (cause) => new WorkspaceProxySessionError({ reason: "invalid_key", cause }),
        ),
      );
    const key = Buffer.from(encoded.trim(), "base64url");
    if (key.length !== 32) {
      return yield* new WorkspaceProxySessionError({ reason: "invalid_key" });
    }
    const hostSuffix = config.hostSuffix.trim().toLowerCase().replace(/^\.+/, "");
    const cookieDomain = config.cookieDomain.trim().toLowerCase();
    if (hostSuffix.length === 0 || !cookieDomain.startsWith(".")) {
      return yield* new WorkspaceProxySessionError({ reason: "invalid_config" });
    }
    return WorkspaceProxySession.of({
      key,
      hostSuffix,
      cookieDomain,
      seal: (claims) => sealWorkspaceProxySession(key, claims),
    });
  }),
);

export const tokenExchangeLayer = Layer.effect(
  WorkspaceTokenExchange,
  Effect.gen(function* () {
    const namespace = (yield* WorkspaceProjection.WorkspaceProjectionConfig).namespace;
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const exchange: WorkspaceTokenExchange["Service"]["exchange"] = Effect.fn(
      "WorkspaceTokenExchange.exchange",
    )(function* (workspaceId, assertion) {
      const url = `http://ws-${workspaceId}.${namespace}.svc.cluster.local:3000/api/auth/hosted-workspace-token`;
      const request = HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyJsonUnsafe({ assertion, client_label: "Hosted web proxy" }),
      );
      const unknown = yield* client.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
        Effect.mapError(
          (cause) => new WorkspaceProxySessionError({ reason: "token_exchange_failed", cause }),
        ),
      );
      const response = yield* Schema.decodeUnknownEffect(ExchangeResponse)(unknown).pipe(
        Effect.mapError(
          (cause) => new WorkspaceProxySessionError({ reason: "token_response_invalid", cause }),
        ),
      );
      return { accessToken: response.access_token, expiresInSeconds: response.expires_in };
    });
    return WorkspaceTokenExchange.of({ exchange });
  }),
);
