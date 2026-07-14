#!/usr/bin/env node

import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ACI_CONTRIBUTOR_ROLE_ID, AUTOMATION_OPERATOR_ROLE_ID, READER_ROLE_ID, createDevelopmentArmClient, decodeJwtClaim, defaultArmOperatorConfigPath, loadArmOperatorConfig, roleDefinitionId } from "./development-arm-auth.mjs";

const require = createRequire(import.meta.url);
const automation = require("../automation-client.js");
const repositoryRoot = resolve(import.meta.dirname, "..");

function parseArguments(values) {
  const result = { configPath: defaultArmOperatorConfigPath(), offline: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--offline") result.offline = true;
    else if (values[index] === "--config" && values[index + 1]) result.configPath = resolve(values[++index]);
    else throw new Error(`Unknown or incomplete argument: ${values[index]}`);
  }
  return result;
}

async function assignedRoleIds(requestJson, scope, principalId) {
  const filter = encodeURIComponent(`principalId eq '${principalId}'`);
  const response = await requestJson(`${scope}/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&$filter=${filter}`);
  return new Set((response?.value || []).map(value => roleDefinitionId(value?.properties?.roleDefinitionId)));
}

function requireRoles(actual, expected, scopeLabel) {
  const missing = expected.filter(role => !actual.has(role.id));
  if (missing.length) throw new Error(`${scopeLabel} is missing: ${missing.map(role => role.name).join(", ")}.`);
}

export async function main(values = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(values);
  const loaded = await (dependencies.loadConfig || loadArmOperatorConfig)({ configPath: options.configPath, repositoryRoot });
  console.log(`External ARM configuration and certificate are valid: ${loaded.configPath}`);
  console.log(`Certificate expires: ${loaded.certificate.validTo}`);
  if (options.offline) {
    console.log("Offline ARM setup check passed. No token was requested and Azure was not called.");
    return;
  }

  const client = (dependencies.createClient || createDevelopmentArmClient)({ config: loaded.config });
  const token = await client.getToken();
  const principalId = String(decodeJwtClaim(token, "oid") || "");
  if (!principalId) throw new Error("The app-only ARM token did not contain a service-principal object ID.");
  const { subscriptionId, resourceGroup } = loaded.config;
  const resourceGroupScope = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}`;
  await client.requestJson(`${resourceGroupScope}?api-version=2021-04-01`);
  await client.requestJson(`${resourceGroupScope}/providers/Microsoft.ContainerInstance/containerGroups?api-version=2023-05-01`);
  const runner = await automation.findRunner({ requestJson: client.requestJson, subscriptionId, resourceGroup, runbookName: "AfterPartyBootstrap" });
  if (!runner) throw new Error("No After Party Automation runner was found in the configured resource group.");
  const accountScope = `${resourceGroupScope}/providers/Microsoft.Automation/automationAccounts/${runner.automationAccountName}`;
  const resourceGroupRoles = await assignedRoleIds(client.requestJson, resourceGroupScope, principalId);
  const accountRoles = await assignedRoleIds(client.requestJson, accountScope, principalId);
  requireRoles(resourceGroupRoles, [
    { id: READER_ROLE_ID, name: "Reader" },
    { id: ACI_CONTRIBUTOR_ROLE_ID, name: "Azure Container Instances Contributor Role" }
  ], "Resource-group RBAC");
  requireRoles(accountRoles, [{ id: AUTOMATION_OPERATOR_ROLE_ID, name: "Automation Operator" }], "Automation-account RBAC");
  console.log(`App-only ARM token and read access are valid for ${resourceGroup}.`);
  console.log(`Required RBAC assignments are present for ${runner.automationAccountName}.`);
  console.log("Live ARM setup check passed without opening a browser or changing a resource.");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(`ARM setup check failed: ${error.message}`);
  process.exitCode = 1;
});
