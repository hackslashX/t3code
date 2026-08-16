import * as Crypto from "node:crypto";
import * as Http from "node:http";

const port = Number(process.env.PORT ?? 18080);
const issuer = process.env.ISSUER ?? `http://127.0.0.1:${port}`;
const clientId = process.env.CLIENT_ID ?? "t3-hosted-test";
const { privateKey, publicKey } = Crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const publicJwk = publicKey.export({ format: "jwk" });
const codes = new Map();
const base64url = (value) => Buffer.from(value).toString("base64url");
const json = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
};
const idToken = (nonce) => {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: "test-key", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: issuer,
      aud: clientId,
      sub: "test-subject",
      email: "invited@example.test",
      email_verified: true,
      name: "Hosted Test User",
      nonce,
      iat: now,
      exp: now + 300,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = Crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
};

const server = Http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", issuer);
  if (url.pathname === "/.well-known/openid-configuration") {
    return json(response, 200, {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (url.pathname === "/jwks") {
    return json(response, 200, {
      keys: [{ ...publicJwk, kid: "test-key", use: "sig", alg: "ES256" }],
    });
  }
  if (url.pathname === "/authorize") {
    const state = url.searchParams.get("state");
    const nonce = url.searchParams.get("nonce");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (state === null || nonce === null || redirectUri === null)
      return json(response, 400, { error: "invalid_request" });
    const code = Crypto.randomBytes(24).toString("base64url");
    codes.set(code, nonce);
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    response.writeHead(302, { location: redirect.toString(), "cache-control": "no-store" });
    return response.end();
  }
  if (url.pathname === "/token" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      const form = new URLSearchParams(body);
      const code = form.get("code");
      const nonce = code === null ? undefined : codes.get(code);
      if (code === null || nonce === undefined)
        return json(response, 400, { error: "invalid_grant" });
      codes.delete(code);
      return json(response, 200, {
        access_token: Crypto.randomBytes(24).toString("base64url"),
        token_type: "Bearer",
        expires_in: 300,
        id_token: idToken(nonce),
      });
    });
    return;
  }
  json(response, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`mock OIDC listening at ${issuer}\n`);
});
