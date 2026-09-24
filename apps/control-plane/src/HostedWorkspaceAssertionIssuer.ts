import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  HostedWorkspaceAssertionMaxLifetimeSeconds,
  HostedWorkspaceAssertionType,
  type AuthEnvironmentScope,
  type HostedWorkspaceAssertionClaims,
} from "@t3tools/contracts/auth";
import type {
  OrganizationId,
  OrganizationRole,
  PrincipalId,
  WorkspaceId,
} from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class HostedWorkspaceAssertionIssuerError extends Schema.TaggedErrorClass<HostedWorkspaceAssertionIssuerError>()(
  "HostedWorkspaceAssertionIssuerError",
  {
    reason: Schema.Literals(["signing_key_read_failed", "signing_key_invalid", "signing_failed"]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

interface IssueInput {
  readonly principalId: PrincipalId;
  readonly organizationId: OrganizationId;
  readonly organizationRole: OrganizationRole;
  readonly workspaceId: WorkspaceId;
  readonly environmentId: string;
}

export interface HostedWorkspaceAssertionResult {
  readonly assertion: string;
  readonly expiresAtEpochSeconds: number;
}

export class HostedWorkspaceAssertionIssuer extends Context.Service<
  HostedWorkspaceAssertionIssuer,
  {
    readonly issue: (
      input: IssueInput,
    ) => Effect.Effect<HostedWorkspaceAssertionResult, HostedWorkspaceAssertionIssuerError>;
  }
>()("@t3tools/control-plane/HostedWorkspaceAssertionIssuer") {}

const issuerConfig = Config.all({
  issuer: Config.string("T3CODE_HOSTED_ASSERTION_ISSUER"),
  keyId: Config.string("T3CODE_HOSTED_ASSERTION_KEY_ID"),
  privateKeyFile: Config.string("T3CODE_HOSTED_ASSERTION_PRIVATE_KEY_FILE"),
  lifetimeSeconds: Config.int("T3CODE_HOSTED_ASSERTION_LIFETIME_SECONDS").pipe(
    Config.withDefault(60),
  ),
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

export const hostedWorkspaceScopesForRole = (
  role: OrganizationRole,
): ReadonlyArray<AuthEnvironmentScope> =>
  role === "viewer" ? [AuthOrchestrationReadScope] : [...AuthStandardClientScopes];

export const signHostedWorkspaceAssertion = (input: {
  readonly claims: HostedWorkspaceAssertionClaims;
  readonly keyId: string;
  readonly privateKey: NodeCrypto.KeyObject;
}) => {
  const signingInput = `${encode({ alg: "ES256", kid: input.keyId, typ: HostedWorkspaceAssertionType })}.${encode(input.claims)}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
};

export const make = Effect.gen(function* () {
  const config = yield* issuerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const pem = yield* fileSystem
    .readFileString(config.privateKeyFile)
    .pipe(
      Effect.mapError(
        (cause) =>
          new HostedWorkspaceAssertionIssuerError({ reason: "signing_key_read_failed", cause }),
      ),
    );
  const privateKey = yield* Effect.try({
    try: () => NodeCrypto.createPrivateKey(pem),
    catch: (cause) =>
      new HostedWorkspaceAssertionIssuerError({ reason: "signing_key_invalid", cause }),
  });
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
    config.issuer.trim().length === 0 ||
    config.keyId.trim().length === 0 ||
    config.lifetimeSeconds < 1 ||
    config.lifetimeSeconds > HostedWorkspaceAssertionMaxLifetimeSeconds
  ) {
    return yield* new HostedWorkspaceAssertionIssuerError({ reason: "signing_key_invalid" });
  }

  const issue: HostedWorkspaceAssertionIssuer["Service"]["issue"] = Effect.fn(
    "HostedWorkspaceAssertionIssuer.issue",
  )(function* (input) {
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
    const expiresAt = now + config.lifetimeSeconds;
    const scopes = hostedWorkspaceScopesForRole(input.organizationRole);
    const claims: HostedWorkspaceAssertionClaims = {
      iss: config.issuer,
      aud: `urn:t3:environment:${input.environmentId}`,
      sub: input.principalId,
      org: input.organizationId,
      workspace: input.workspaceId,
      environment: input.environmentId,
      scope: [...scopes],
      iat: now,
      nbf: now - 5,
      exp: expiresAt,
      jti: NodeCrypto.randomUUID(),
    };
    const assertion = yield* Effect.try({
      try: () => signHostedWorkspaceAssertion({ claims, keyId: config.keyId, privateKey }),
      catch: (cause) =>
        new HostedWorkspaceAssertionIssuerError({ reason: "signing_failed", cause }),
    });
    return { assertion, expiresAtEpochSeconds: expiresAt };
  });
  return HostedWorkspaceAssertionIssuer.of({ issue });
});

export const layer = Layer.effect(HostedWorkspaceAssertionIssuer, make);
