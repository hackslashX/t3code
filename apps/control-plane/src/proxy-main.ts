// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- Dedicated streaming proxy boundary uses Node HTTP upgrade sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeFs from "node:fs";

import {
  openWorkspaceProxySession,
  WORKSPACE_PROXY_SESSION_COOKIE,
} from "./WorkspaceProxySession.ts";

const port = Number(process.env.T3CODE_WORKSPACE_PROXY_PORT ?? "3002");
const bindHost = process.env.T3CODE_WORKSPACE_PROXY_BIND_HOST ?? "0.0.0.0";
const namespace = process.env.T3CODE_WORKSPACE_NAMESPACE?.trim();
const upstreamHostSuffix =
  process.env.T3CODE_WORKSPACE_PROXY_UPSTREAM_HOST_SUFFIX?.trim().toLowerCase() ||
  (namespace === undefined ? undefined : `${namespace}.svc.cluster.local`);
const hostSuffix = process.env.T3CODE_WORKSPACE_PROXY_HOST_SUFFIX?.trim()
  .toLowerCase()
  .replace(/^\.+/, "");
const keyFile = process.env.T3CODE_WORKSPACE_PROXY_SESSION_KEY_FILE;
if (
  !namespace ||
  !upstreamHostSuffix ||
  !hostSuffix ||
  !keyFile ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
) {
  throw new Error("Invalid workspace proxy configuration");
}
const sessionKey = Buffer.from(NodeFs.readFileSync(keyFile, "utf8").trim(), "base64url");
if (sessionKey.length !== 32) throw new Error("Invalid workspace proxy session key");

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const hostPattern = new RegExp(
  `^(t3|code)-(${uuid})\\.${hostSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
  "i",
);
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const cookieValue = (header: string | undefined, name: string) => {
  if (header === undefined) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
};

const targetFor = (request: NodeHttp.IncomingMessage) => {
  const host = request.headers.host?.split(":", 1)[0]?.toLowerCase();
  const match = host === undefined ? null : hostPattern.exec(host);
  if (match === null) return undefined;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    try {
      if (new URL(origin).hostname.toLowerCase() !== host) return undefined;
    } catch {
      return undefined;
    }
  } else if (!new Set(["GET", "HEAD", "OPTIONS"]).has(request.method ?? "")) {
    return undefined;
  }
  const service = match[1]!.toLowerCase() as "t3" | "code";
  const workspaceId = match[2]!.toLowerCase();
  const sealed = cookieValue(request.headers.cookie, WORKSPACE_PROXY_SESSION_COOKIE);
  if (sealed === undefined) return undefined;
  const claims = openWorkspaceProxySession(sessionKey, sealed, Math.floor(Date.now() / 1_000));
  if (claims.workspaceId !== workspaceId) return undefined;
  return {
    service,
    workspaceId,
    accessToken: claims.accessToken,
    host: `ws-${workspaceId}.${upstreamHostSuffix}`,
    port: service === "t3" ? 3000 : 3001,
    externalHost: host,
  };
};

const upstreamHeaders = (
  request: NodeHttp.IncomingMessage,
  target: NonNullable<ReturnType<typeof targetFor>>,
) => {
  const headers: NodeHttp.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (
      value === undefined ||
      hopHeaders.has(name) ||
      name === "host" ||
      name === "cookie" ||
      name === "authorization" ||
      name === "forwarded" ||
      name.startsWith("x-forwarded-")
    )
      continue;
    headers[name] = value;
  }
  headers.host = `${target.host}:${target.port}`;
  headers.origin =
    target.service === "t3"
      ? `http://${target.host}:${target.port}`
      : (request.headers.origin ?? `https://${target.externalHost}`);
  headers["x-forwarded-host"] = target.externalHost;
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-for"] = request.socket.remoteAddress ?? "unknown";
  if (target.service === "t3") headers.authorization = `Bearer ${target.accessToken}`;
  return headers;
};

const sendError = (response: NodeHttp.ServerResponse, status: number) => {
  if (response.headersSent) return response.destroy();
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(
    JSON.stringify({ error: status === 401 ? "workspace_session_required" : "bad_gateway" }),
  );
};

const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"status":"ok"}');
    return;
  }
  let target: ReturnType<typeof targetFor>;
  try {
    target = targetFor(request);
  } catch {
    return sendError(response, 401);
  }
  if (target === undefined) return sendError(response, 401);
  const upstream = NodeHttp.request(
    {
      host: target.host,
      port: target.port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request, target),
    },
    (upstreamResponse) => {
      const headers: NodeHttp.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || hopHeaders.has(name) || name === "set-cookie") continue;
        if (name === "location" && typeof value === "string") {
          headers.location = value.replace(
            `http://${target.host}:${target.port}`,
            `https://${target.externalHost}`,
          );
        } else headers[name] = value;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => sendError(response, 502));
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});

server.on("upgrade", (request, socket, head) => {
  let target: ReturnType<typeof targetFor>;
  try {
    target = targetFor(request);
  } catch {
    socket.destroy();
    return;
  }
  if (target === undefined) {
    process.stderr.write("workspace proxy rejected WebSocket upgrade\n");
    return socket.destroy();
  }
  const headers = upstreamHeaders(request, target);
  headers.connection = "Upgrade";
  headers.upgrade = "websocket";
  const upstream = NodeHttp.request({
    host: target.host,
    port: target.port,
    method: "GET",
    path: request.url,
    headers,
  });
  upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
    process.stderr.write(
      `workspace proxy upgraded ${target.service} WebSocket with status ${upstreamResponse.statusCode ?? 101}\n`,
    );
    socket.write(
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n` +
        Object.entries(upstreamResponse.headers)
          .filter(([name, value]) => value !== undefined && name !== "set-cookie")
          .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(", ") : value}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    socket.pipe(upstreamSocket).pipe(socket);
  });
  upstream.on("response", (upstreamResponse) => {
    process.stderr.write(
      `workspace proxy upstream rejected ${target.service} WebSocket with status ${upstreamResponse.statusCode ?? 502}\n`,
    );
    socket.write(
      `HTTP/1.1 ${upstreamResponse.statusCode ?? 502} Bad Gateway\r\nConnection: close\r\n\r\n`,
    );
    socket.destroy();
  });
  upstream.on("error", (error) => {
    process.stderr.write(`workspace proxy WebSocket upstream error: ${error.message}\n`);
    socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  upstream.end();
});

const sockets = new Set<NodeNet.Socket>();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
const shutdown = () => {
  server.close(() => process.exit(0));
  for (const socket of sockets) socket.destroy();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
server.listen(port, bindHost, () => {
  process.stdout.write(`workspace proxy listening on http://${bindHost}:${port}\n`);
});
