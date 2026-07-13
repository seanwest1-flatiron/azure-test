import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { isTransientArmFailure, retryArmRequest } = require("../arm-retry.js");

test("retries a bounded number of network failures with short exponential backoff", async () => {
  let requests = 0;
  const delays = [];
  const result = await retryArmRequest(async () => {
    requests += 1;
    if (requests < 3) throw new TypeError("Failed to fetch");
    return "ok";
  }, { method: "GET", sleep: async delay => delays.push(delay) });

  assert.equal(result, "ok");
  assert.equal(requests, 3);
  assert.deepEqual(delays, [200, 400]);
});

test("recognizes transient ARM response statuses", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isTransientArmFailure({ status }), true);
  for (const status of [400, 401, 403, 404, 409]) assert.equal(isTransientArmFailure({ status }), false);
});

test("retries a transient PUT using the same request action", async () => {
  let requests = 0;
  await retryArmRequest(async () => {
    requests += 1;
    if (requests === 1) throw Object.assign(new Error("Service unavailable"), { status: 503 });
  }, { method: "PUT", sleep: async () => {} });

  assert.equal(requests, 2);
});

test("does not retry a generic POST that could duplicate side effects", async () => {
  let requests = 0;
  await assert.rejects(() => retryArmRequest(async () => {
    requests += 1;
    throw new TypeError("Failed to fetch");
  }, { method: "POST", sleep: async () => {} }), /Failed to fetch/);

  assert.equal(requests, 1);
});

test("stops after the configured bound and preserves the final error", async () => {
  let requests = 0;
  const failure = Object.assign(new Error("Still unavailable"), { status: 502 });
  await assert.rejects(() => retryArmRequest(async () => {
    requests += 1;
    throw failure;
  }, { method: "GET", sleep: async () => {} }), error => error === failure);

  assert.equal(requests, 3);
});
