import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EnvironmentHttpApi,
  HostedWorkspaceAssertionType,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as HostedWorkspaceAuthConfig from "./HostedWorkspaceAuthConfig.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const environmentId = EnvironmentId.make("hosted-http-test");
const keyPair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const hostedConfig = {
  enabled: true,
  issuer: "https://control.example.test",
  workspaceId: "workspace-1",
  publicKeys: new Map([["key-1", keyPair.publicKey]]),
  sessionLifetimeSeconds: 300,
} as const;

const issueAssertion = (overrides: Record<string, unknown> = {}) => {
  const header = { alg: "ES256", kid: "key-1", typ: HostedWorkspaceAssertionType };
  const claims = {
    iss: hostedConfig.issuer,
    aud: `urn:t3:environment:${environmentId}`,
    sub: "principal-1",
    org: "organization-1",
    workspace: hostedConfig.workspaceId,
    environment: environmentId,
    scope: ["orchestration:read", "terminal:operate"],
    iat: 0,
    nbf: 0,
    exp: 60,
    jti: NodeCrypto.randomUUID(),
    ...overrides,
  };
  const input = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(input), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
};

const postAssertion = (assertion: string) =>
  new Request("http://127.0.0.1/api/auth/hosted-workspace-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion, client_label: "Hosted web" }),
  });

const withRoutes = Effect.fnUntraced(function* (
  config: HostedWorkspaceAuthConfig.HostedWorkspaceAuthConfigValue,
  run: (handler: ReturnType<typeof HttpRouter.toWebHandler>["handler"]) => Promise<void>,
) {
  const crypto = yield* Crypto.Crypto;
  const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
    Context.add(Clock.Clock, yield* Clock.Clock),
  );
  const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-hosted-http-test-" });
  const layerIdentity = Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const layerAuth = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(layerIdentity),
    Layer.provide(layerConfig),
  );
  const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerAuth),
    Layer.provide(layerIdentity),
    Layer.provide(Layer.succeed(HostedWorkspaceAuthConfig.HostedWorkspaceAuthConfig, config)),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
  yield* Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
    ({ handler }) => Effect.promise(() => run((request) => handler(request, requestContext))),
    ({ dispose }) => Effect.promise(dispose),
  );
});

it.effect("exchanges a hosted assertion for a scoped session and rejects replay", () =>
  withRoutes(hostedConfig, async (handler) => {
    const assertion = issueAssertion();
    const response = await handler(postAssertion(assertion));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      token_type: "Bearer",
      scope: "orchestration:read terminal:operate",
      expires_in: 300,
    });
    const session = await handler(
      new Request("http://127.0.0.1/api/auth/session", {
        headers: { authorization: `Bearer ${body.access_token}` },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      authenticated: true,
      scopes: ["orchestration:read", "terminal:operate"],
    });
    const replay = await handler(postAssertion(assertion));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ reason: "invalid_credential" });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects hosted assertion trust and scope violations", () =>
  withRoutes(hostedConfig, async (handler) => {
    for (const overrides of [
      { iss: "https://other.example.test" },
      { aud: "urn:t3:environment:other" },
      { workspace: "workspace-2" },
      { environment: "other" },
      { exp: -1 },
      { scope: ["access:write"] },
    ]) {
      const response = await handler(postAssertion(issueAssertion(overrides)));
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: "invalid_credential" });
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects hosted assertions when hosted authentication is disabled", () =>
  withRoutes({ enabled: false }, async (handler) => {
    const response = await handler(postAssertion(issueAssertion()));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: "invalid_credential" });
  }).pipe(Effect.provide(NodeServices.layer)),
);
