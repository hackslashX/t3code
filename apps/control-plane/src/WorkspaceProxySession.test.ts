import { assert, describe, it } from "@effect/vitest";
import { WorkspaceId } from "@t3tools/hosted-contracts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

import {
  openWorkspaceProxySession,
  sealWorkspaceProxySession,
  WorkspaceProxySessionError,
} from "./WorkspaceProxySession.ts";

const workspaceId = WorkspaceId.make("00000000-0000-4000-8000-000000000020");

describe("WorkspaceProxySession", () => {
  it("seals opaque workspace grant credentials", () => {
    const key = NodeCrypto.randomBytes(32);
    const sealed = sealWorkspaceProxySession(key, {
      workspaceId,
      credential: "workspace-grant",
      expiresAtEpochSeconds: 200,
    });
    assert.notInclude(sealed, "workspace-grant");
    assert.deepEqual(openWorkspaceProxySession(key, sealed, 100), {
      workspaceId,
      credential: "workspace-grant",
      expiresAtEpochSeconds: 200,
    });
  });

  it("rejects tampering, expiry, and the wrong key", () => {
    const key = NodeCrypto.randomBytes(32);
    const sealed = sealWorkspaceProxySession(key, {
      workspaceId,
      credential: "token",
      expiresAtEpochSeconds: 200,
    });
    const expectReason = (reason: WorkspaceProxySessionError["reason"], run: () => unknown) => {
      try {
        run();
        assert.fail("expected proxy session rejection");
      } catch (error) {
        assert.isTrue(Schema.is(WorkspaceProxySessionError)(error));
        assert.equal((error as WorkspaceProxySessionError).reason, reason);
      }
    };
    expectReason("session_expired", () => openWorkspaceProxySession(key, sealed, 200));
    expectReason("invalid_session", () =>
      openWorkspaceProxySession(NodeCrypto.randomBytes(32), sealed, 100),
    );
    expectReason("invalid_session", () =>
      openWorkspaceProxySession(key, `${sealed.slice(0, -1)}A`, 100),
    );
  });
});
