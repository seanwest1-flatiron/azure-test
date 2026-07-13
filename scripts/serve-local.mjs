import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync, watch } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4173;
export const BROWSER_ORIGIN = `http://localhost:${DEFAULT_PORT}`;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRootDirectory = resolve(scriptDirectory, "..");
const blockedSegments = new Set([".artifacts", ".git", ".github", "_site", "scripts", "tests"]);
const contentTypes = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
});

function gitCommit(rootDirectory) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "uncommitted";
  }
}

export function localDeploymentManifest({ commit, deployedAt = new Date().toISOString() }) {
  return Object.freeze({
    commit: `local-${commit}`,
    deployedAt,
    environment: "local"
  });
}

function requestHostAllowed(request) {
  try {
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
  } catch {
    return false;
  }
}

function send(response, statusCode, body = "", headers = {}, headOnly = false) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Length": value.byteLength,
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(headOnly ? undefined : value);
}

function requestedFile(rootDirectory, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some(segment => segment.startsWith(".") || blockedSegments.has(segment))) return null;
  const filePath = resolve(rootDirectory, decoded === "/" ? "index.html" : `.${decoded}`);
  const pathWithinRoot = relative(rootDirectory, filePath);
  if (pathWithinRoot.startsWith(`..${sep}`) || pathWithinRoot === ".." || isAbsolute(pathWithinRoot)) return null;
  return filePath;
}

function injectLiveReload(index) {
  const source = '<script src="/__after_party_live_reload.js"></script>';
  return index.includes("</body>") ? index.replace("</body>", `  ${source}\n</body>`) : `${index}\n${source}\n`;
}

function liveReloadClient() {
  return `(() => {
  const events = new EventSource("/__after_party_events");
  events.addEventListener("reload", () => window.location.reload());
})();\n`;
}

export async function startLocalServer({
  rootDirectory = defaultRootDirectory,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  watchForChanges = true,
  commit = gitCommit(rootDirectory),
  deployedAt = new Date().toISOString()
} = {}) {
  const root = resolve(rootDirectory);
  const deployment = localDeploymentManifest({ commit, deployedAt });
  const eventClients = new Set();

  const server = createServer((request, response) => {
    if (!requestHostAllowed(request)) return send(response, 400, "Invalid host.\n", { "Content-Type": "text/plain; charset=utf-8" });
    const headOnly = request.method === "HEAD";
    if (request.method !== "GET" && !headOnly) {
      return send(response, 405, "Method not allowed.\n", { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
    }

    const url = new URL(request.url, BROWSER_ORIGIN);
    if (url.pathname === "/__after_party_events") {
      if (headOnly) return send(response, 200, "", { "Content-Type": "text/event-stream" }, true);
      response.writeHead(200, {
        "Cache-Control": "no-store, max-age=0",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
        "X-Content-Type-Options": "nosniff"
      });
      response.write("event: ready\ndata: connected\n\n");
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (url.pathname === "/__after_party_live_reload.js") {
      return send(response, 200, liveReloadClient(), { "Content-Type": contentTypes[".js"] }, headOnly);
    }
    if (url.pathname === "/deployment.json") {
      return send(response, 200, `${JSON.stringify(deployment, null, 2)}\n`, { "Content-Type": contentTypes[".json"] }, headOnly);
    }

    const filePath = requestedFile(root, url.pathname);
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      return send(response, 404, "Not found.\n", { "Content-Type": "text/plain; charset=utf-8" }, headOnly);
    }
    const type = contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream";
    if (filePath === resolve(root, "index.html")) {
      const chunks = [];
      const stream = createReadStream(filePath);
      stream.on("data", chunk => chunks.push(chunk));
      stream.on("error", () => send(response, 500, "Unable to read file.\n", { "Content-Type": "text/plain; charset=utf-8" }, headOnly));
      stream.on("end", () => send(response, 200, injectLiveReload(Buffer.concat(chunks).toString("utf8")), { "Content-Type": type }, headOnly));
      return;
    }

    const size = statSync(filePath).size;
    response.writeHead(200, {
      "Cache-Control": "no-store, max-age=0",
      "Content-Length": size,
      "Content-Type": type,
      "X-Content-Type-Options": "nosniff"
    });
    if (headOnly) return response.end();
    createReadStream(filePath).pipe(response);
  });

  let watcher;
  let reloadTimer;
  await new Promise((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    server.listen(port, host, () => {
      server.off("error", rejectListening);
      resolveListening();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (watchForChanges) {
    watcher = watch(root, { persistent: false }, (eventType, filename) => {
      if (!filename || !/[.](?:css|html|js|json)$/.test(filename)) return;
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        for (const client of eventClients) client.write(`event: reload\ndata: ${Date.now()}\n\n`);
      }, 75);
    });
  }

  const close = async () => {
    clearTimeout(reloadTimer);
    watcher?.close();
    for (const client of eventClients) client.end();
    eventClients.clear();
    await new Promise((resolveClose, rejectClose) => {
      server.close(error => error ? rejectClose(error) : resolveClose());
      server.closeAllConnections?.();
    });
  };

  return Object.freeze({
    server,
    deployment,
    url: `http://localhost:${actualPort}/`,
    close
  });
}

async function main() {
  const local = await startLocalServer();
  console.log(`After Party local site: ${local.url}`);
  console.log("Live reload and no-cache responses are enabled. Press Ctrl+C to stop.");
  console.log(`Local MSAL redirects require ${BROWSER_ORIGIN}/ to be registered as an SPA redirect URI.`);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await local.close();
    console.log("Local server stopped.");
  };
  process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`Unable to start the local server: ${error.message}`);
    process.exitCode = 1;
  });
}
