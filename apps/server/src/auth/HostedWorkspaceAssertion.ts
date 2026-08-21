import {
  HostedWorkspaceAssertionClaims,
  HostedWorkspaceAssertionHeader,
  HostedWorkspaceAssertionMaxLifetimeSeconds,
  type AuthEnvironmentScope,
  type HostedWorkspaceAssertionClaims as HostedWorkspaceAssertionClaimsType,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "./ServerSecretStore.ts";

export const HostedWorkspaceAssertionRejectionReason = Schema.Literals([
  "malformed",
  "invalid_header",
  "unknown_key",
  "invalid_signature",
  "wrong_issuer",
  "wrong_audience",
  "wrong_workspace",
  "wrong_environment",
  "not_active",
  "expired",
  "invalid_lifetime",
  "scope_not_allowed",
  "replayed",
]);
export type HostedWorkspaceAssertionRejectionReason =
  typeof HostedWorkspaceAssertionRejectionReason.Type;

export class HostedWorkspaceAssertionRejectedError extends Schema.TaggedErrorClass<HostedWorkspaceAssertionRejectedError>()(
  "HostedWorkspaceAssertionRejectedError",
  { reason: HostedWorkspaceAssertionRejectionReason },
) {}

export class HostedWorkspaceAssertionReplayRecordError extends Schema.TaggedErrorClass<HostedWorkspaceAssertionReplayRecordError>()(
  "HostedWorkspaceAssertionReplayRecordError",
  { cause: Schema.Defect() },
) {}

export interface HostedWorkspaceAssertionReplayStore {
  readonly consume: (assertionId: string, expiresAt: number, now: number) => boolean;
}

export interface DecodeHostedWorkspaceAssertionInput {
  readonly assertion: string;
  readonly publicKeys: ReadonlyMap<string, NodeCrypto.KeyObject>;
  readonly issuer: string;
  readonly audience: string;
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly allowedScopes: ReadonlySet<AuthEnvironmentScope>;
  readonly now: number;
  readonly clockSkewSeconds?: number;
}

export interface VerifyHostedWorkspaceAssertionInput extends DecodeHostedWorkspaceAssertionInput {
  readonly replayStore: HostedWorkspaceAssertionReplayStore;
}

const decodePart = (part: string): unknown =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

const reject = (reason: HostedWorkspaceAssertionRejectionReason) => {
  throw new HostedWorkspaceAssertionRejectedError({ reason });
};

export function decodeHostedWorkspaceAssertion(input: DecodeHostedWorkspaceAssertionInput) {
  const [encodedHeaderPart, encodedClaimsPart, encodedSignature, extraPart] =
    input.assertion.split(".");
  if (
    encodedHeaderPart === undefined ||
    encodedClaimsPart === undefined ||
    encodedSignature === undefined ||
    extraPart !== undefined
  ) {
    return reject("malformed");
  }

  let encodedHeader: unknown;
  let encodedClaims: unknown;
  try {
    encodedHeader = decodePart(encodedHeaderPart);
    encodedClaims = decodePart(encodedClaimsPart);
  } catch {
    return reject("malformed");
  }

  const decodedHeader = Schema.decodeUnknownOption(HostedWorkspaceAssertionHeader)(encodedHeader);
  if (Option.isNone(decodedHeader)) return reject("invalid_header");
  const header = decodedHeader.value;
  const publicKey = input.publicKeys.get(header.kid);
  if (publicKey === undefined) return reject("unknown_key");

  const validSignature = NodeCrypto.verify(
    "sha256",
    Buffer.from(`${encodedHeaderPart}.${encodedClaimsPart}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!validSignature) return reject("invalid_signature");

  const decodedClaims = Schema.decodeUnknownOption(HostedWorkspaceAssertionClaims)(encodedClaims);
  if (Option.isNone(decodedClaims)) return reject("malformed");
  const claims = decodedClaims.value;
  const clockSkewSeconds = input.clockSkewSeconds ?? 5;

  if (claims.iss !== input.issuer) return reject("wrong_issuer");
  if (claims.aud !== input.audience) return reject("wrong_audience");
  if (claims.workspace !== input.workspaceId) return reject("wrong_workspace");
  if (claims.environment !== input.environmentId) return reject("wrong_environment");
  if (claims.iat > input.now + clockSkewSeconds || claims.nbf > input.now + clockSkewSeconds) {
    return reject("not_active");
  }
  if (claims.exp < input.now - clockSkewSeconds) return reject("expired");
  if (
    claims.exp <= claims.iat ||
    claims.exp - claims.iat > HostedWorkspaceAssertionMaxLifetimeSeconds
  ) {
    return reject("invalid_lifetime");
  }
  if (claims.scope.some((scope) => !input.allowedScopes.has(scope))) {
    return reject("scope_not_allowed");
  }

  return claims;
}

export function verifyHostedWorkspaceAssertion(input: VerifyHostedWorkspaceAssertionInput) {
  const claims = decodeHostedWorkspaceAssertion(input);
  if (!input.replayStore.consume(claims.jti, claims.exp, input.now)) return reject("replayed");
  return claims;
}

export const consumeHostedWorkspaceAssertionReplay = Effect.fn(
  "HostedWorkspaceAssertion.consumeReplay",
)(function* (claims: HostedWorkspaceAssertionClaimsType) {
  const now = yield* DateTime.now;
  const replayKey = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.digest("SHA-256", new TextEncoder().encode(`${claims.iss}:${claims.jti}`)),
    ),
    Effect.map(Encoding.encodeBase64Url),
    Effect.mapError((cause) => new HostedWorkspaceAssertionReplayRecordError({ cause })),
  );
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  yield* secretStore
    .create(
      `hosted-workspace-assertion-${replayKey}`,
      new TextEncoder().encode(
        [
          `issuer=${claims.iss}`,
          `jti=${claims.jti}`,
          `workspace=${claims.workspace}`,
          `environment=${claims.environment}`,
          `expiresAt=${claims.exp}`,
          `consumedAt=${DateTime.formatIso(now)}`,
        ].join("\n"),
      ),
    )
    .pipe(
      Effect.mapError((cause) =>
        ServerSecretStore.isSecretAlreadyExistsError(cause)
          ? new HostedWorkspaceAssertionRejectedError({ reason: "replayed" })
          : new HostedWorkspaceAssertionReplayRecordError({ cause }),
      ),
    );
});

export function makeMemoryHostedWorkspaceAssertionReplayStore(): HostedWorkspaceAssertionReplayStore {
  const consumed = new Map<string, number>();
  return {
    consume(assertionId, expiresAt, now) {
      for (const [id, expiry] of consumed) {
        if (expiry < now) consumed.delete(id);
      }
      if (consumed.has(assertionId)) return false;
      consumed.set(assertionId, expiresAt);
      return true;
    },
  };
}
