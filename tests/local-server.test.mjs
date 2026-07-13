import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLocalServer } from "../scripts/serve-local.mjs";

function statusWithHost(url, host) {
  return new Promise((resolveStatus, rejectStatus) => {
    const target = new URL(url);
    const outgoing = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: { Host: host }
    }, response => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode));
    });
    outgoing.on("error", rejectStatus);
    outgoing.end();
  });
}

function waitForReload(url, changeFile) {
  return new Promise((resolveReload, rejectReload) => {
    let ready = false;
    const timeout = setTimeout(() => {
      outgoing.destroy();
      rejectReload(new Error("Timed out waiting for the live-reload event."));
    }, 2000);
    const outgoing = request(url, response => {
      response.setEncoding("utf8");
      response.on("data", chunk => {
        if (!ready && chunk.includes("event: ready")) {
          ready = true;
          void changeFile().catch(rejectReload);
        }
        if (!chunk.includes("event: reload")) return;
        clearTimeout(timeout);
        outgoing.destroy();
        resolveReload();
      });
    });
    outgoing.on("error", error => {
      clearTimeout(timeout);
      rejectReload(error);
    });
    outgoing.end();
  });
}

async function fixture() {
  const rootDirectory = await mkdtemp(join(tmpdir(), "after-party-local-server-"));
  await Promise.all([
    writeFile(join(rootDirectory, "index.html"), "<!doctype html><body><main>Local site</main></body>\n"),
    writeFile(join(rootDirectory, "app.js"), "window.fixture = true;\n"),
    mkdir(join(rootDirectory, ".git")),
    mkdir(join(rootDirectory, "scripts"))
  ]);
  await Promise.all([
    writeFile(join(rootDirectory, ".git", "config"), "not public\n"),
    writeFile(join(rootDirectory, "scripts", "private.js"), "not public\n")
  ]);
  return rootDirectory;
}

test("serves a no-cache local site with live reload and virtual deployment metadata", async t => {
  const rootDirectory = await fixture();
  const local = await startLocalServer({
    rootDirectory,
    port: 0,
    watchForChanges: false,
    commit: "abc123",
    deployedAt: "2026-07-13T12:34:56.000Z"
  });
  t.after(async () => {
    await local.close();
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const origin = local.url.replace("localhost", "127.0.0.1").replace(/\/$/, "");

  const indexResponse = await fetch(`${origin}/`);
  assert.equal(indexResponse.status, 200);
  assert.equal(indexResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(indexResponse.headers.get("content-type"), /^text\/html/);
  assert.match(await indexResponse.text(), /__after_party_live_reload[.]js/);

  const assetResponse = await fetch(`${origin}/app.js?v=local`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(assetResponse.headers.get("content-type"), /^text\/javascript/);
  assert.equal(await assetResponse.text(), "window.fixture = true;\n");

  const deploymentResponse = await fetch(`${origin}/deployment.json?nonce=1`);
  assert.deepEqual(await deploymentResponse.json(), {
    commit: "local-abc123",
    deployedAt: "2026-07-13T12:34:56.000Z",
    environment: "local"
  });

  const reloadResponse = await fetch(`${origin}/__after_party_live_reload.js`);
  assert.match(await reloadResponse.text(), /new EventSource/);

  const headResponse = await fetch(`${origin}/app.js`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");
});

test("rejects non-loopback hosts, unsafe paths, and mutating methods", async t => {
  const rootDirectory = await fixture();
  const local = await startLocalServer({ rootDirectory, port: 0, watchForChanges: false, commit: "abc123" });
  t.after(async () => {
    await local.close();
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const origin = local.url.replace("localhost", "127.0.0.1").replace(/\/$/, "");

  assert.equal((await fetch(`${origin}/.git/config`)).status, 404);
  assert.equal((await fetch(`${origin}/scripts/private.js`)).status, 404);
  assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
  assert.equal((await fetch(`${origin}/app.js`, { method: "POST" })).status, 405);
  assert.equal(await statusWithHost(`${origin}/app.js`, "example.test"), 400);
});

test("publishes a reload event when a frontend file changes", async t => {
  const rootDirectory = await fixture();
  const local = await startLocalServer({ rootDirectory, port: 0, commit: "abc123" });
  t.after(async () => {
    await local.close();
    await rm(rootDirectory, { recursive: true, force: true });
  });
  const origin = local.url.replace("localhost", "127.0.0.1").replace(/\/$/, "");

  await waitForReload(`${origin}/__after_party_events`, () => (
    writeFile(join(rootDirectory, "app.js"), "window.fixture = 'changed';\n")
  ));
});
