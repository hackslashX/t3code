import {
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  HostedWorkspaceAssertionType,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import {
  HostedWorkspaceAssertionRejectedError,
  makeMemoryHostedWorkspaceAssertionReplayStore,
  verifyHostedWorkspaceAssertion,
} from "./HostedWorkspaceAssertion.ts";

const now = 1_800_000_000;
const issuer = "https://control.example.test";
const audience = "urn:t3:environment:env-1";
const workspaceId = "workspace-1";
const environmentId = "env-1";
const keyPair = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });

function issue(overrides: Record<string, unknown> = {}) {
  const header = { alg: "ES256", kid: "key-1", typ: HostedWorkspaceAssertionType };
  const claims = {
    iss: issuer,
    aud: audience,
    sub: "principal-1",
    org: "org-1",
    workspace: workspaceId,
    environment: environmentId,
    scope: [AuthOrchestrationReadScope, AuthTerminalOperateScope],
    iat: now,
    nbf: now,
    exp: now + 60,
    jti: "assertion-1",
    ...overrides,
  };
  const signingInput = `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: keyPair.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

function verify(
  assertion: string,
  overrides: Partial<Parameters<typeof verifyHostedWorkspaceAssertion>[0]> = {},
) {
  return verifyHostedWorkspaceAssertion({
    assertion,
    publicKeys: new Map([["key-1", keyPair.publicKey]]),
    issuer,
    audience,
    workspaceId,
    environmentId,
    allowedScopes: new Set<AuthEnvironmentScope>([
      AuthOrchestrationReadScope,
      AuthTerminalOperateScope,
    ]),
    replayStore: makeMemoryHostedWorkspaceAssertionReplayStore(),
    now,
    ...overrides,
  });
}

function expectRejection(
  reason: HostedWorkspaceAssertionRejectedError["reason"],
  run: () => unknown,
) {
  expect(run).toThrowError(expect.objectContaining({ reason }));
}

describe("verifyHostedWorkspaceAssertion", () => {
  it("accepts a valid workspace-bound assertion", () => {
    expect(verify(issue())).toMatchObject({
      sub: "principal-1",
      org: "org-1",
      workspace: workspaceId,
      environment: environmentId,
    });
  });

  it("rejects trust-boundary confusion", () => {
    expectRejection("wrong_issuer", () => verify(issue(), { issuer: "https://other.test" }));
    expectRejection("wrong_audience", () => verify(issue(), { audience: "other" }));
    expectRejection("wrong_workspace", () => verify(issue(), { workspaceId: "workspace-2" }));
    expectRejection("wrong_environment", () => verify(issue(), { environmentId: "env-2" }));
  });

  it("rejects time and scope violations", () => {
    expectRejection("expired", () => verify(issue({ exp: now + 1 }), { now: now + 10 }));
    expectRejection("invalid_lifetime", () => verify(issue({ exp: now + 301 })));
    expectRejection("not_active", () => verify(issue({ iat: now + 10, nbf: now + 10 })));
    expectRejection("scope_not_allowed", () => verify(issue({ scope: ["access:write"] })));
  });

  it("rejects assertion replay", () => {
    const assertion = issue();
    const replayStore = makeMemoryHostedWorkspaceAssertionReplayStore();
    verify(assertion, { replayStore });
    expectRejection("replayed", () => verify(assertion, { replayStore }));
  });

  it("accepts overlapping signing keys and rejects unknown keys", () => {
    const rotated = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(
      verify(issue(), {
        publicKeys: new Map([
          ["key-1", keyPair.publicKey],
          ["key-2", rotated.publicKey],
        ]),
      }),
    ).toBeDefined();
    expectRejection("unknown_key", () => verify(issue(), { publicKeys: new Map() }));
  });
});
