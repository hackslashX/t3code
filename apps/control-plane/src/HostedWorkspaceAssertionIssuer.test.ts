import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  HostedWorkspaceAssertionType,
} from "@t3tools/contracts/auth";
import * as NodeCrypto from "node:crypto";

import {
  hostedWorkspaceScopesForRole,
  signHostedWorkspaceAssertion,
} from "./HostedWorkspaceAssertionIssuer.ts";

const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

describe("HostedWorkspaceAssertionIssuer", () => {
  it("signs an ES256 assertion with the configured key ID", () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    const claims = {
      iss: "https://control.example.test",
      aud: "urn:t3:environment:environment-1",
      sub: "principal-1",
      org: "organization-1",
      workspace: "workspace-1",
      environment: "environment-1",
      scope: [...AuthStandardClientScopes],
      iat: 100,
      nbf: 95,
      exp: 160,
      jti: "assertion-1",
    };
    const assertion = signHostedWorkspaceAssertion({ claims, keyId: "key-1", privateKey });
    const [encodedHeader, encodedClaims, encodedSignature] = assertion.split(".");
    assert.deepEqual(decode(encodedHeader!), {
      alg: "ES256",
      kid: "key-1",
      typ: HostedWorkspaceAssertionType,
    });
    assert.deepEqual(decode(encodedClaims!), claims);
    assert.isTrue(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedClaims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(encodedSignature!, "base64url"),
      ),
    );
  });

  it("limits viewers to orchestration reads", () => {
    assert.deepEqual(hostedWorkspaceScopesForRole("viewer"), [AuthOrchestrationReadScope]);
    assert.deepEqual(hostedWorkspaceScopesForRole("member"), [...AuthStandardClientScopes]);
  });
});
