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
