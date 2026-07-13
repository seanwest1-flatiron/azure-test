#!/usr/bin/env node
"use strict";

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automation = require("../../automation-client.js");
const ARM = "https://management.azure.com";
const inspectPayload = "tests/live/inspect-failed-sign-in-detection.ps1";
const mutationPayload = "payloads/create-failed-sign-in-detection.ps1";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function jwtClaims(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("AFTER_PARTY_ARM_TOKEN is not a JWT.");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

async function main() {
  if (process.env.AFTER_PARTY_ALLOW_LIVE_TESTS !== "1") throw new Error("Set AFTER_PARTY_ALLOW_LIVE_TESTS=1 only when the current task explicitly authorizes live validation.");
  const expectedTenant = requiredEnvironment("AFTER_PARTY_EXPECTED_TENANT").toLowerCase();
  const expectedTenantId = requiredEnvironment("AFTER_PARTY_EXPECTED_TENANT_ID").toLowerCase();
  const desiredState = requiredEnvironment("AFTER_PARTY_DESIRED_RULE_STATE").toLowerCase();
  if (desiredState !== "enabled") throw new Error("This validator only supports the explicit final state 'enabled'.");
  const subscriptionId = requiredEnvironment("AFTER_PARTY_SUBSCRIPTION_ID");
  const resourceGroup = requiredEnvironment("AFTER_PARTY_RESOURCE_GROUP");
  const accessToken = requiredEnvironment("AFTER_PARTY_ARM_TOKEN");
  const claims = jwtClaims(accessToken);
  if (String(claims.tid).toLowerCase() !== expectedTenantId) throw new Error(`ARM token tenant '${claims.tid}' did not match expected tenant ID '${expectedTenantId}'.`);
  const signedInName = String(claims.upn || claims.preferred_username || "").toLowerCase();
  if (!signedInName.endsWith(`@${expectedTenant}`)) throw new Error(`Authenticated Azure account '${signedInName || "unknown"}' did not belong to '${expectedTenant}'.`);

  const request = async (path, options = {}, textResponse = false) => {
    const response = await fetch(`${ARM}${path}`, {
      ...options,
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`ARM ${options.method || "GET"} ${path} failed with HTTP ${response.status}: ${body}`);
    if (textResponse) return body.trim().replace(/^"|"$/g, "");
    return body ? JSON.parse(body) : null;
  };
  const requestJson = (path, options) => request(path, options);
  const requestText = path => request(path, {}, true);
  const runner = await automation.findRunner({ requestJson, subscriptionId, resourceGroup, runbookName: "AfterPartyBootstrap" });
  if (!runner) throw new Error(`No After Party Automation account was found in resource group '${resourceGroup}'.`);

  async function run(payloadPath) {
    const jobId = randomUUID();
    const { jobPath } = await automation.startJob({ requestJson, runner, payloadPath, jobId, parameters: {} });
    const result = await automation.waitForJob({ requestJson, requestText, jobPath });
    return { jobId, ...result };
  }

  async function inspect() {
    const result = await run(inspectPayload);
    if (result.status !== "Completed") throw new Error(`Live inspection job ${result.jobId} ended as ${result.status}: ${result.output}`);
    const marker = result.output.split(/\r?\n/).find(line => line.startsWith("AFTER_PARTY_LIVE_RESULT="));
    if (!marker) throw new Error(`Live inspection job ${result.jobId} did not return its result marker.`);
    const state = JSON.parse(marker.slice("AFTER_PARTY_LIVE_RESULT=".length));
    if (String(state.tenantDomain).toLowerCase() !== expectedTenant) throw new Error(`Resolved tenant '${state.tenantDomain}' did not match expected tenant '${expectedTenant}'.`);
    return { jobId: result.jobId, state };
  }

  const before = await inspect();
  let mutation = null;
  if (!before.state.ruleExists || before.state.rule?.status === "disabled") {
    mutation = await run(mutationPayload);
  } else if (before.state.rule?.status !== "enabled") {
    throw new Error(`Rule status '${before.state.rule?.status}' is not safe for an automatic ensure-enabled mutation.`);
  }
  const after = await inspect();
  console.log(JSON.stringify({ authenticatedAccount: signedInName, expectedTenant, desiredState, before, mutation: mutation && { jobId: mutation.jobId, status: mutation.status, output: mutation.output }, after }, null, 2));
  if (mutation && mutation.status !== "Completed") process.exitCode = 1;
  if (!after.state.ruleExists || after.state.rule?.status !== "enabled") process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
