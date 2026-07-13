import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automation = require("../automation-client.js");

test("starts the requested payload through the bootstrap runbook", async () => {
  let request;
  const runner = { subscriptionId: "sub id", resourceGroup: "rg/name", automationAccountName: "after-party-account", runbookName: "AfterPartyBootstrap" };
  const result = await automation.startJob({
    requestJson: async (path, options) => { request = { path, options }; },
    runner,
    payloadPath: "payloads/send-email.ps1",
    jobId: "job-id"
  });

  assert.equal(request.options.method, "PUT");
  assert.equal(JSON.parse(request.options.body).properties.runbook.name, "AfterPartyBootstrap");
  assert.equal(JSON.parse(request.options.body).properties.parameters.LabPath, "payloads/send-email.ps1");
  assert.equal(result.jobPath, "/subscriptions/sub%20id/resourcegroups/rg%2Fname/providers/Microsoft.Automation/automationAccounts/after-party-account/jobs/job-id");
});

test("passes browser worker context only when the caller supplies it", async () => {
  let request;
  await automation.startJob({
    requestJson: async (path, options) => { request = { path, options }; },
    runner: { subscriptionId: "sub", resourceGroup: "rg", automationAccountName: "account", runbookName: "AfterPartyBootstrap" },
    payloadPath: "payloads/browser-failed-sign-in.ps1",
    jobId: "job-id",
    parameters: { SubscriptionId: "sub", ResourceGroup: "rg" }
  });

  assert.deepEqual(JSON.parse(request.options.body).properties.parameters, {
    LabPath: "payloads/browser-failed-sign-in.ps1",
    SubscriptionId: "sub",
    ResourceGroup: "rg"
  });
});

test("serializes the three non-interactive failed sign-ins job with its attempt count", async () => {
  let request;
  await automation.startJob({
    requestJson: async (path, options) => { request = { path, options }; },
    runner: { subscriptionId: "sub", resourceGroup: "rg", automationAccountName: "account", runbookName: "AfterPartyBootstrap" },
    payloadPath: "payloads/failed-sign-in.ps1",
    jobId: "job-id",
    parameters: { AttemptCount: "3" }
  });

  assert.deepEqual(JSON.parse(request.options.body).properties.parameters, {
    LabPath: "payloads/failed-sign-in.ps1",
    AttemptCount: "3"
  });
});

test("leaves the ordinary failed sign-in job at the payload default", async () => {
  let request;
  await automation.startJob({
    requestJson: async (path, options) => { request = { path, options }; },
    runner: { subscriptionId: "sub", resourceGroup: "rg", automationAccountName: "account", runbookName: "AfterPartyBootstrap" },
    payloadPath: "payloads/failed-sign-in.ps1",
    jobId: "job-id"
  });

  assert.deepEqual(JSON.parse(request.options.body).properties.parameters, {
    LabPath: "payloads/failed-sign-in.ps1"
  });
});

test("returns complete output and Automation error streams", async () => {
  const result = await automation.waitForJob({
    requestJson: async path => path.includes("/streams?")
      ? { value: [{ properties: { streamType: "Error", streamText: "stream failure" } }] }
      : { properties: { status: "Failed", exception: "job exception" } },
    requestText: async () => "runbook output",
    jobPath: "/jobs/job-id",
    intervalMs: 0
  });

  assert.equal(result.status, "Failed");
  assert.equal(result.output, "runbook output\njob exception\nstream failure");
});

test("discovers runner and tenant baseline versions from Azure tags", async () => {
  const runner = await automation.findRunner({
    requestJson: async path => path.includes("/runbooks/") ? {} : { value: [{ name: "after-party-account", tags: { "after-party-runner": "true", "after-party-runner-version": "runner-2", "after-party-tenant-baseline-version": "baseline-3" } }] },
    subscriptionId: "sub",
    resourceGroup: "rg",
    runbookName: "AfterPartyBootstrap"
  });

  assert.equal(runner.runnerVersion, "runner-2");
  assert.equal(runner.tenantBaselineVersion, "baseline-3");
});
