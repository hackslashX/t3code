import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";

const root = "/app/web";
const port = Number(process.env.PORT ?? "8080");
const indexHtml = readFileSync(join(root, "index.html"), "utf8");
const inlineScriptHashes = [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1] ?? "")
  .filter((script) => script.length > 0)
  .map((script) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`)
  .join(" ");
const types = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"status":"ok"}');
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { allow: "GET, HEAD" });
    response.end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    response.writeHead(400);
    response.end();
    return;
  }
  const relative = normalize(pathname).replace(/^[/\\]+/, "");
  let file = join(root, relative);
  if (file !== root && !file.startsWith(`${root}/`)) {
    response.writeHead(404);
    response.end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    if (!statSync(file).isFile()) throw new Error("not a file");
  } catch {
    file = join(root, "index.html");
  }
  const extension = extname(file);
  response.writeHead(200, {
    "content-type": types.get(extension) ?? "application/octet-stream",
    "cache-control": file.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    "content-security-policy": `default-src 'self'; connect-src 'self' https: wss:; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; script-src 'self' ${inlineScriptHashes}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
    "referrer-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  if (request.method === "HEAD") response.end();
  else createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0");
