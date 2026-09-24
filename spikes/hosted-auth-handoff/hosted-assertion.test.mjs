import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";

import {
  HostedAssertionError,
  createMemoryReplayStore,
  issueHostedAssertion,
  verifyHostedAssertion,
} from "./hosted-assertion.mjs";

const now = 1_800_000_000;
const issuer = "https://control.example.test";
const audience = "urn:t3:environment:env-1";
const workspaceId = "workspace-1";
const environmentId = "env-1";
const allowedScopes = ["orchestration:read", "orchestration:operate", "terminal:operate"];
const keyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
const rotatedKeyPair = generateKeyPairSync("ec", { namedCurve: "P-256" });

function issue(overrides = {}) {
  return issueHostedAssertion({
    privateKey: keyPair.privateKey,
    keyId: "key-1",
    issuer,
    audience,
    principalId: "principal-1",
    organizationId: "org-1",
    workspaceId,
    environmentId,
    scopes: ["orchestration:read", "terminal:operate"],
    now,
    assertionId: "assertion-1",
    ...overrides,
  });
}

function verify(assertion, overrides = {}) {
  return verifyHostedAssertion(assertion, {
    publicKeys: new Map([["key-1", keyPair.publicKey]]),
    issuer,
    audience,
    workspaceId,
    environmentId,
    allowedScopes,
    replayStore: createMemoryReplayStore(),
    now,
    ...overrides,
  });
}

function rejectsCode(code, fn) {
  assert.throws(fn, (error) => error instanceof HostedAssertionError && error.code === code);
}

test("verifies a workspace-bound assertion", () => {
  assert.deepEqual(verify(issue()), {
    assertionId: "assertion-1",
    principalId: "principal-1",
    organizationId: "org-1",
    workspaceId,
    environmentId,
    scopes: ["orchestration:read", "terminal:operate"],
    issuedAt: now,
    expiresAt: now + 60,
  });
});

test("rejects issuer, audience, workspace, and environment confusion", () => {
  rejectsCode("wrong_issuer", () => verify(issue(), { issuer: "https://other.example.test" }));
  rejectsCode("wrong_audience", () => verify(issue(), { audience: "urn:t3:environment:other" }));
  rejectsCode("wrong_workspace", () => verify(issue(), { workspaceId: "workspace-2" }));
  rejectsCode("wrong_environment", () => verify(issue(), { environmentId: "env-2" }));
});

test("rejects expiry, excessive lifetime, and future assertions", () => {
  rejectsCode("expired", () => verify(issue({ lifetimeSeconds: 1 }), { now: now + 10 }));
  rejectsCode("invalid_lifetime", () => issue({ lifetimeSeconds: 301 }));
  rejectsCode("not_active", () => verify(issue({ now: now + 10 }), { now }));
});

test("rejects scopes outside the environment grant", () => {
  rejectsCode("scope_not_allowed", () => verify(issue({ scopes: ["access:write"] })));
});

test("rejects replay", () => {
  const assertion = issue();
  const replayStore = createMemoryReplayStore();
  verify(assertion, { replayStore });
  rejectsCode("replayed", () => verify(assertion, { replayStore }));
});

test("supports overlapping keys during rotation", () => {
  const assertion = issueHostedAssertion({
    privateKey: rotatedKeyPair.privateKey,
    keyId: "key-2",
    issuer,
    audience,
    principalId: "principal-1",
    organizationId: "org-1",
    workspaceId,
    environmentId,
    scopes: ["orchestration:read"],
    now,
  });
  const result = verify(assertion, {
    publicKeys: new Map([
      ["key-1", keyPair.publicKey],
      ["key-2", rotatedKeyPair.publicKey],
    ]),
  });
  assert.deepEqual(result.scopes, ["orchestration:read"]);
});

test("rejects tampering and unknown signing keys", () => {
  const assertion = issue();
  const parts = assertion.split(".");
  parts[2] = `${parts[2].slice(0, -1)}${parts[2].endsWith("A") ? "B" : "A"}`;
  rejectsCode("invalid_signature", () => verify(parts.join(".")));
  rejectsCode("unknown_key", () => verify(assertion, { publicKeys: new Map() }));
});
