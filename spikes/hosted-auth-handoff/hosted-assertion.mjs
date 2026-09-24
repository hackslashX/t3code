import { randomUUID, sign, verify } from "node:crypto";

export const HOSTED_ASSERTION_TYPE = "t3-hosted-workspace+jwt";
export const MAX_ASSERTION_LIFETIME_SECONDS = 300;

const encode = (value) => Buffer.from(value).toString("base64url");
const decodeJson = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

export class HostedAssertionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HostedAssertionError";
    this.code = code;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HostedAssertionError("invalid_claims", `${field} must be a non-empty string`);
  }
  return value;
}

function requireInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new HostedAssertionError("invalid_claims", `${field} must be an integer`);
  }
  return value;
}

function requireScopes(value) {
  if (!Array.isArray(value) || value.some((scope) => typeof scope !== "string")) {
    throw new HostedAssertionError("invalid_claims", "scope must be an array of strings");
  }
  return [...new Set(value)];
}

export function issueHostedAssertion({
  privateKey,
  keyId,
  issuer,
  audience,
  principalId,
  organizationId,
  workspaceId,
  environmentId,
  scopes,
  now = Math.floor(Date.now() / 1000),
  lifetimeSeconds = 60,
  assertionId = randomUUID(),
}) {
  if (
    !Number.isInteger(lifetimeSeconds) ||
    lifetimeSeconds < 1 ||
    lifetimeSeconds > MAX_ASSERTION_LIFETIME_SECONDS
  ) {
    throw new HostedAssertionError("invalid_lifetime");
  }

  const header = { alg: "ES256", kid: requireString(keyId, "keyId"), typ: HOSTED_ASSERTION_TYPE };
  const claims = {
    iss: requireString(issuer, "issuer"),
    aud: requireString(audience, "audience"),
    sub: requireString(principalId, "principalId"),
    org: requireString(organizationId, "organizationId"),
    workspace: requireString(workspaceId, "workspaceId"),
    environment: requireString(environmentId, "environmentId"),
    scope: requireScopes(scopes),
    iat: now,
    nbf: now,
    exp: now + lifetimeSeconds,
    jti: requireString(assertionId, "assertionId"),
  };
  const signingInput = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${signature.toString("base64url")}`;
}

export function createMemoryReplayStore() {
  const consumed = new Map();
  return {
    consume(jti, expiresAt, now) {
      for (const [id, expiry] of consumed) {
        if (expiry < now) consumed.delete(id);
      }
      if (consumed.has(jti)) return false;
      consumed.set(jti, expiresAt);
      return true;
    },
  };
}

export function verifyHostedAssertion(
  assertion,
  {
    publicKeys,
    issuer,
    audience,
    workspaceId,
    environmentId,
    allowedScopes,
    replayStore,
    now = Math.floor(Date.now() / 1000),
    clockSkewSeconds = 5,
  },
) {
  if (typeof assertion !== "string") throw new HostedAssertionError("malformed");
  const parts = assertion.split(".");
  if (parts.length !== 3) throw new HostedAssertionError("malformed");

  let header;
  let claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new HostedAssertionError("malformed");
  }

  if (
    header.alg !== "ES256" ||
    header.typ !== HOSTED_ASSERTION_TYPE ||
    typeof header.kid !== "string"
  ) {
    throw new HostedAssertionError("invalid_header");
  }
  const publicKey = publicKeys.get(header.kid);
  if (!publicKey) throw new HostedAssertionError("unknown_key");

  const validSignature = verify(
    "sha256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    {
      key: publicKey,
      dsaEncoding: "ieee-p1363",
    },
    Buffer.from(parts[2], "base64url"),
  );
  if (!validSignature) throw new HostedAssertionError("invalid_signature");

  const actualIssuer = requireString(claims.iss, "iss");
  const actualAudience = requireString(claims.aud, "aud");
  const actualWorkspace = requireString(claims.workspace, "workspace");
  const actualEnvironment = requireString(claims.environment, "environment");
  const principalId = requireString(claims.sub, "sub");
  const organizationId = requireString(claims.org, "org");
  const assertionId = requireString(claims.jti, "jti");
  const issuedAt = requireInteger(claims.iat, "iat");
  const notBefore = requireInteger(claims.nbf, "nbf");
  const expiresAt = requireInteger(claims.exp, "exp");
  const scopes = requireScopes(claims.scope);

  if (actualIssuer !== issuer) throw new HostedAssertionError("wrong_issuer");
  if (actualAudience !== audience) throw new HostedAssertionError("wrong_audience");
  if (actualWorkspace !== workspaceId) throw new HostedAssertionError("wrong_workspace");
  if (actualEnvironment !== environmentId) throw new HostedAssertionError("wrong_environment");
  if (issuedAt > now + clockSkewSeconds || notBefore > now + clockSkewSeconds) {
    throw new HostedAssertionError("not_active");
  }
  if (expiresAt < now - clockSkewSeconds) throw new HostedAssertionError("expired");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_ASSERTION_LIFETIME_SECONDS) {
    throw new HostedAssertionError("invalid_lifetime");
  }

  const allowed = new Set(allowedScopes);
  if (scopes.some((scope) => !allowed.has(scope)))
    throw new HostedAssertionError("scope_not_allowed");
  if (!replayStore.consume(assertionId, expiresAt, now)) throw new HostedAssertionError("replayed");

  return {
    assertionId,
    principalId,
    organizationId,
    workspaceId: actualWorkspace,
    environmentId: actualEnvironment,
    scopes,
    issuedAt,
    expiresAt,
  };
}
