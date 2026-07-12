#!/usr/bin/env node
"use strict";

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const automation = require("../automation-client.js");
const ARM = "https://management.azure.com";

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/run-lab.mjs --resource-group <name> --lab <payloads/file.ps1> [--subscription <id>] [--automation-account <name>] [--runbook <name>]");
  process.exit(2);
}

function argumentsFrom(commandLine) {
  const result = {};
  for (let index = 0; index < commandLine.length; index += 2) {
    const key = commandLine[index];
    const value = commandLine[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) usage(`Missing value for ${key || "argument"}.`);
    result[key.slice(2)] = value;
  }
  return result;
}

function azJson(...args) {
  try {
    return JSON.parse(execFileSync("az", [...args, "--output", "json", "--only-show-errors"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    const detail = error.stderr?.trim() || error.message;
    throw new Error(`Azure CLI authentication is unavailable. Run 'az login' and try again. ${detail}`);
  }
}

async function main() {
  const args = argumentsFrom(process.argv.slice(2));
  if (!args["resource-group"] || !args.lab) usage("Both --resource-group and --lab are required.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ps1$/.test(args.lab)) usage("--lab must be a repository-relative PowerShell payload path.");

  const subscriptionId = args.subscription || azJson("account", "show").id;
  const accessToken = process.env.AFTER_PARTY_ARM_TOKEN || azJson("account", "get-access-token", "--resource", ARM).accessToken;
  const request = async (path, options = {}, textResponse = false) => {
    const response = await fetch(`${ARM}${path}`, {
      ...options,
      headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}`, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers }
    });
    const text = await response.text();
    if (!response.ok) {
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      const error = new Error(body?.error?.message || text || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    if (textResponse) return text.trim().replace(/^"|"$/g, "");
    return text ? JSON.parse(text) : null;
  };
  const requestJson = (path, options) => request(path, options);
  const requestText = path => request(path, {}, true);
  const runbookName = args.runbook || "AfterPartyBootstrap";
  const runner = args["automation-account"]
    ? { subscriptionId, resourceGroup: args["resource-group"], automationAccountName: args["automation-account"], runbookName }
    : await automation.findRunner({ requestJson, subscriptionId, resourceGroup: args["resource-group"], runbookName });
  if (!runner) throw new Error(`No After Party Automation account was found in resource group '${args["resource-group"]}'.`);

  const jobId = randomUUID();
  console.error(`Starting ${args.lab} in ${runner.automationAccountName}. Job ID: ${jobId}`);
  const parameters = args.lab === "payloads/browser-failed-sign-in.ps1"
    ? { SubscriptionId: subscriptionId, ResourceGroup: args["resource-group"] }
    : {};
  const { jobPath } = await automation.startJob({ requestJson, runner, payloadPath: args.lab, jobId, parameters });
  let lastStatus;
  const result = await automation.waitForJob({
    requestJson,
    requestText,
    jobPath,
    onStatus: ({ status }) => {
      if (status === lastStatus) return;
      lastStatus = status;
      console.error(`Job ${jobId}: ${status}`);
    }
  });
  if (result.output) console.log(result.output);
  else console.log(result.job?.properties?.statusDetails || `Job finished with status ${result.status}.`);
  if (result.status !== "Completed") process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
