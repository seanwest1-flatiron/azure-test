#!/usr/bin/env node
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDevelopmentArmClient, defaultArmOperatorConfigPath, loadArmOperatorConfig } from "./development-arm-auth.mjs";

const require = createRequire(import.meta.url);
const automation = require("../automation-client.js");
const repositoryRoot = resolve(import.meta.dirname, "..");

function usage(message) {
  if (message) console.error(message);
  throw new Error("Usage: node scripts/run-lab.mjs --lab <payloads/file.ps1> [--config <external-config>] [--subscription <id>] [--resource-group <name>] [--automation-account <name>] [--runbook <name>] [--capture-browser-page <1>]");
}

export function argumentsFrom(commandLine) {
  const result = {};
  for (let index = 0; index < commandLine.length; index += 2) {
    const key = commandLine[index];
    const value = commandLine[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) usage(`Missing value for ${key || "argument"}.`);
    result[key.slice(2)] = value;
  }
  return result;
}

export async function main(values = process.argv.slice(2), dependencies = {}) {
  const args = argumentsFrom(values);
  if (!args.lab) usage("--lab is required.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ps1$/.test(args.lab)) usage("--lab must be a repository-relative PowerShell payload path.");
  if (args["capture-browser-page"] && args["capture-browser-page"] !== "1") usage("--capture-browser-page accepts only 1.");
  const loaded = await (dependencies.loadConfig || loadArmOperatorConfig)({
    configPath: resolve(args.config || defaultArmOperatorConfigPath()),
    repositoryRoot
  });
  const { config } = loaded;
  if (args.subscription && args.subscription.toLowerCase() !== config.subscriptionId.toLowerCase()) {
    throw new Error("--subscription does not match the approved external ARM test configuration.");
  }
  if (args["resource-group"] && args["resource-group"].toLowerCase() !== config.resourceGroup.toLowerCase()) {
    throw new Error("--resource-group does not match the approved external ARM test configuration.");
  }
  const subscriptionId = config.subscriptionId;
  const resourceGroup = config.resourceGroup;
  const client = (dependencies.createClient || createDevelopmentArmClient)({ config });
  const { requestJson, requestText } = client;
  console.error(`Authentication: app-only ARM certificate for ${resourceGroup}; no browser will open.`);
  const runbookName = args.runbook || "AfterPartyBootstrap";
  const runner = args["automation-account"]
    ? { subscriptionId, resourceGroup, automationAccountName: args["automation-account"], runbookName }
    : await automation.findRunner({ requestJson, subscriptionId, resourceGroup, runbookName });
  if (!runner) throw new Error(`No After Party Automation account was found in resource group '${resourceGroup}'.`);

  const jobId = randomUUID();
  console.error(`Starting ${args.lab} in ${runner.automationAccountName}. Job ID: ${jobId}`);
  const parameters = ["payloads/browser-failed-sign-in.ps1", "payloads/tap-sign-in.ps1"].includes(args.lab)
    ? {
        SubscriptionId: subscriptionId,
        ResourceGroup: resourceGroup,
        ...(args["attempt-count"] ? { AttemptCount: args["attempt-count"] } : {}),
        ...(args["capture-browser-page"] ? { CaptureBrowserPage: args["capture-browser-page"] } : {})
      }
    : args.lab === "payloads/failed-sign-in.ps1" && args["attempt-count"] ? { AttemptCount: args["attempt-count"] } : {};
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
  if (result.status !== "Completed") throw new Error(`Automation job finished with status ${result.status}.`);
  return result;
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
