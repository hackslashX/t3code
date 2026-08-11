import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const LoginTransaction = Schema.Struct({
  state: Schema.String,
  nonce: Schema.String,
  verifier: Schema.String,
  returnTo: Schema.String,
  invitationToken: Schema.optionalKey(Schema.String),
  issuedAt: Schema.Int,
  expiresAt: Schema.Int,
});
type LoginTransaction = typeof LoginTransaction.Type;

export class OidcLoginTransactionError extends Schema.TaggedErrorClass<OidcLoginTransactionError>()(
  "OidcLoginTransactionError",
  {
    reason: Schema.Literals([
      "invalid_key",
      "invalid_return_to",
      "malformed_transaction",
      "state_mismatch",
      "transaction_expired",
    ]),
  },
) {}

const reject = (reason: OidcLoginTransactionError["reason"]): never => {
  throw new OidcLoginTransactionError({ reason });
};
const randomValue = (bytes = 32) => NodeCrypto.randomBytes(bytes).toString("base64url");
const challengeForVerifier = (verifier: string) =>
  NodeCrypto.createHash("sha256").update(verifier).digest("base64url");

export function decodeOidcTransactionKey(encoded: string): Buffer {
  let key: Buffer;
  try {
    key = Buffer.from(encoded.trim(), "base64url");
  } catch {
    return reject("invalid_key");
  }
  if (key.length !== 32) return reject("invalid_key");
  return key;
}

export function validateReturnTo(returnTo: string): string {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//") || returnTo.includes("\\")) {
    return reject("invalid_return_to");
  }
  return returnTo;
}

export function createOidcLoginTransaction(input: {
  readonly key: Buffer;
  readonly returnTo: string;
  readonly nowEpochSeconds: number;
  readonly ttlSeconds?: number;
  readonly invitationToken?: string;
}) {
  if (input.key.length !== 32) return reject("invalid_key");
  const ttlSeconds = input.ttlSeconds ?? 600;
  const transaction: LoginTransaction = {
    state: randomValue(),
    nonce: randomValue(),
    verifier: randomValue(48),
    returnTo: validateReturnTo(input.returnTo),
    ...(input.invitationToken === undefined ? {} : { invitationToken: input.invitationToken }),
    issuedAt: input.nowEpochSeconds,
    expiresAt: input.nowEpochSeconds + ttlSeconds,
  };
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", input.key, iv);
  cipher.setAAD(Buffer.from("t3-hosted-oidc-login-v1"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(transaction), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    state: transaction.state,
    nonce: transaction.nonce,
    verifier: transaction.verifier,
    codeChallenge: challengeForVerifier(transaction.verifier),
    encryptedTransaction: Buffer.concat([iv, tag, ciphertext]).toString("base64url"),
  };
}

export function consumeOidcLoginTransaction(input: {
  readonly key: Buffer;
  readonly encryptedTransaction: string;
  readonly returnedState: string;
  readonly nowEpochSeconds: number;
}): LoginTransaction {
  if (input.key.length !== 32) return reject("invalid_key");
  try {
    const packed = Buffer.from(input.encryptedTransaction, "base64url");
    if (packed.length < 29) return reject("malformed_transaction");
    const iv = packed.subarray(0, 12);
    const tag = packed.subarray(12, 28);
    const ciphertext = packed.subarray(28);
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", input.key, iv);
    decipher.setAAD(Buffer.from("t3-hosted-oidc-login-v1"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const decoded = Schema.decodeUnknownSync(LoginTransaction)(JSON.parse(plaintext));
    const expectedState = Buffer.from(decoded.state);
    const returnedState = Buffer.from(input.returnedState);
    if (
      expectedState.length !== returnedState.length ||
      !NodeCrypto.timingSafeEqual(expectedState, returnedState)
    ) {
      return reject("state_mismatch");
    }
    if (decoded.expiresAt < input.nowEpochSeconds) return reject("transaction_expired");
    return decoded;
  } catch (cause) {
    if (Schema.is(OidcLoginTransactionError)(cause)) throw cause;
    return reject("malformed_transaction");
  }
}
