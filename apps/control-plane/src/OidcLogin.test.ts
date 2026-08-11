import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import {
  consumeOidcLoginTransaction,
  createOidcLoginTransaction,
  decodeOidcTransactionKey,
  validateReturnTo,
} from "./OidcLogin.ts";

const key = NodeCrypto.randomBytes(32);

it("creates and consumes a PKCE login transaction", () => {
  const created = createOidcLoginTransaction({
    key,
    returnTo: "/organizations/org-1/workspaces",
    nowEpochSeconds: 1000,
    invitationToken: "invite-secret",
  });
  assert.match(created.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  const consumed = consumeOidcLoginTransaction({
    key,
    encryptedTransaction: created.encryptedTransaction,
    returnedState: created.state,
    nowEpochSeconds: 1100,
  });
  assert.equal(consumed.nonce, created.nonce);
  assert.equal(consumed.verifier, created.verifier);
  assert.equal(consumed.returnTo, "/organizations/org-1/workspaces");
  assert.equal(consumed.invitationToken, "invite-secret");
});

it("rejects state mismatch, expiry, and ciphertext tampering", () => {
  const created = createOidcLoginTransaction({ key, returnTo: "/", nowEpochSeconds: 1000 });
  assert.throws(() =>
    consumeOidcLoginTransaction({
      key,
      encryptedTransaction: created.encryptedTransaction,
      returnedState: "wrong",
      nowEpochSeconds: 1001,
    }),
  );
  assert.throws(() =>
    consumeOidcLoginTransaction({
      key,
      encryptedTransaction: created.encryptedTransaction,
      returnedState: created.state,
      nowEpochSeconds: 2000,
    }),
  );
  const tampered = `${created.encryptedTransaction.slice(0, -1)}A`;
  assert.throws(() =>
    consumeOidcLoginTransaction({
      key,
      encryptedTransaction: tampered,
      returnedState: created.state,
      nowEpochSeconds: 1001,
    }),
  );
});

it("accepts only same-origin path return targets", () => {
  assert.equal(validateReturnTo("/settings"), "/settings");
  assert.throws(() => validateReturnTo("https://evil.example"));
  assert.throws(() => validateReturnTo("//evil.example/path"));
  assert.throws(() => validateReturnTo("/\\evil"));
});

it("loads exactly 256-bit transaction keys", () => {
  const encoded = key.toString("base64url");
  assert.deepEqual(decodeOidcTransactionKey(encoded), key);
  assert.throws(() => decodeOidcTransactionKey("short"));
});
