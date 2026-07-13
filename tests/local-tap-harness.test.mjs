import assert from "node:assert/strict";
import test from "node:test";
import { pathIsInside, runWithManagedTemporaryAccessPass, validateHarnessConfig } from "../scripts/local-tap-harness.mjs";
import { parseArguments } from "../scripts/run-local-tap-sign-in.mjs";

const config = Object.freeze({
  tenantId: "11111111-1111-4111-8111-111111111111",
  tenantDomain: "student.onmicrosoft.com",
  provisioningClientId: "22222222-2222-4222-8222-222222222222",
  signInClientId: "33333333-3333-4333-8333-333333333333",
  certificatePath: "/outside/credential.pem",
  userAlias: "lisa.simpson",
  expectedDisplayName: "Lisa Simpson"
});

function response(status, value) {
  return new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: value === undefined ? {} : { "Content-Type": "application/json" }
  });
}

function graphMock({ existing = [], deleteStatus = 204 } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url, method: options.method || "GET", headers: options.headers, body: options.body };
    calls.push(call);
    if (call.method === "GET") return response(200, { value: existing });
    if (call.method === "POST") return response(201, { id: "tap-method-id", temporaryAccessPass: "one-time-secret" });
    if (call.method === "DELETE" && deleteStatus === 204) return response(204);
    return response(deleteStatus, { error: { code: "cleanup_failed", message: "Delete was rejected." } });
  };
  return { calls, fetchImpl };
}

const credential = { getToken: async scope => ({ token: `app-token-for:${scope}` }) };

test("validates tenant-relative external configuration", () => {
  assert.deepEqual(validateHarnessConfig(config), config);
  assert.equal(pathIsInside("/repo", "/repo/config.json"), true);
  assert.equal(pathIsInside("/repo", "/outside/config.json"), false);
  assert.throws(() => validateHarnessConfig({ ...config, expectedDisplayName: "Someone Else" }), /Lisa Simpson/);
  assert.throws(() => validateHarnessConfig({ ...config, certificatePath: "relative.pem" }), /absolute/);
});

test("runs headless by default and exposes an explicit headed debugging option", () => {
  assert.equal(parseArguments([]).headless, true);
  assert.equal(parseArguments(["--headed"]).headless, false);
  assert.throws(() => parseArguments(["--headless"]), /Unknown/);
});

test("creates a single-use TAP, runs the shared sign-in, and deletes only that TAP", async () => {
  const graph = graphMock();
  const logs = [];
  let received;
  const result = await runWithManagedTemporaryAccessPass({
    config,
    credential,
    fetchImpl: graph.fetchImpl,
    logger: (stage, status) => logs.push(`${stage}:${status}`),
    runSignIn: async input => {
      received = input;
      return { result: "confirmed", displayName: "Lisa Simpson", upn: "lisa.simpson@student.onmicrosoft.com" };
    }
  });
  assert.equal(result.result, "confirmed");
  assert.equal(received.temporaryAccessPass, "one-time-secret");
  assert.equal(received.clientId, config.signInClientId);
  assert.equal(received.headless, true);
  assert.equal(JSON.stringify(logs).includes("one-time-secret"), false);
  assert.deepEqual(graph.calls.map(call => call.method), ["GET", "POST", "DELETE"]);
  assert.match(graph.calls[1].body, /"isUsableOnce":true/);
  assert.match(graph.calls[2].url, /temporaryAccessPassMethods\/tap-method-id$/);
});

test("deletes the created TAP when browser sign-in fails", async () => {
  const graph = graphMock();
  await assert.rejects(runWithManagedTemporaryAccessPass({
    config,
    credential,
    fetchImpl: graph.fetchImpl,
    runSignIn: async () => { throw new Error("browser failed"); }
  }), /browser failed/);
  assert.deepEqual(graph.calls.map(call => call.method), ["GET", "POST", "DELETE"]);
});

test("refuses to replace an existing TAP", async () => {
  const graph = graphMock({ existing: [{ id: "preexisting" }] });
  await assert.rejects(runWithManagedTemporaryAccessPass({
    config,
    credential,
    fetchImpl: graph.fetchImpl,
    runSignIn: async () => assert.fail("sign-in must not run")
  }), /already has a Temporary Access Pass/);
  assert.deepEqual(graph.calls.map(call => call.method), ["GET"]);
});

test("surfaces cleanup failure even when sign-in also fails", async () => {
  const graph = graphMock({ deleteStatus: 403 });
  await assert.rejects(runWithManagedTemporaryAccessPass({
    config,
    credential,
    fetchImpl: graph.fetchImpl,
    runSignIn: async () => { throw new Error("browser failed"); }
  }), error => {
    assert.match(error.message, /Temporary Access Pass cleanup failed/);
    assert.match(error.message, /cleanup_failed/);
    assert.match(error.message, /Primary failure: browser failed/);
    return true;
  });
});
