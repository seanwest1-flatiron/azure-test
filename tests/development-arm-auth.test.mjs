import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createDevelopmentArmClient, roleDefinitionId, validateArmOperatorConfig } from "../scripts/development-arm-auth.mjs";
import { main as checkArm } from "../scripts/check-development-arm-auth.mjs";
import { renderWorkflowTable } from "../scripts/list-development-tests.mjs";
import { argumentsFrom, main as runLab } from "../scripts/run-lab.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const clientId = "22222222-2222-4222-8222-222222222222";
const subscriptionId = "33333333-3333-4333-8333-333333333333";
const config = Object.freeze({ tenantId, clientId, subscriptionId, resourceGroup: "after-test", certificatePath: "/external/credential.pem" });

function token(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("validates the external app-only ARM boundary", () => {
  assert.deepEqual(validateArmOperatorConfig(config), config);
  assert.throws(() => validateArmOperatorConfig({ ...config, tenantId: "organizations" }), /tenantId/);
  assert.throws(() => validateArmOperatorConfig({ ...config, certificatePath: "credential.pem" }), /absolute/);
  assert.throws(() => validateArmOperatorConfig({ ...config, resourceGroup: "bad?group" }), /resourceGroup/);
  assert.equal(roleDefinitionId("/providers/Microsoft.Authorization/roleDefinitions/ABC"), "abc");
});

test("uses a certificate credential and confirms tenant and app claims on every ARM request", async () => {
  const calls = [];
  const credential = {
    getToken: async scope => {
      calls.push({ scope });
      return { token: token({ tid: tenantId, appid: clientId }), expiresOnTimestamp: Date.now() + 3600000 };
    }
  };
  const client = createDevelopmentArmClient({
    config,
    credential,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ value: "ok" }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  });
  const result = await client.requestJson("/subscriptions/sub?api-version=test");
  assert.equal(result.value, "ok");
  assert.equal(calls[0].scope, "https://management.azure.com/.default");
  assert.match(calls[1].options.headers.Authorization, /^Bearer header\./);
  assert.equal(JSON.stringify(calls).includes("InteractiveBrowserCredential"), false);
});

test("rejects an ARM token issued to another tenant or application", async () => {
  const fetchImpl = async () => { throw new Error("fetch must not run"); };
  await assert.rejects(createDevelopmentArmClient({
    config,
    credential: { getToken: async () => ({ token: token({ tid: "44444444-4444-4444-8444-444444444444", appid: clientId }) }) },
    fetchImpl
  }).requestJson("/resource"), /unexpected tenant/);
  await assert.rejects(createDevelopmentArmClient({
    config,
    credential: { getToken: async () => ({ token: token({ tid: tenantId, appid: "44444444-4444-4444-8444-444444444444" }) }) },
    fetchImpl
  }).requestJson("/resource"), /unexpected application/);
});

test("runs Automation with external app-only configuration and forwards explicit capture", async () => {
  const requests = [];
  const requestJson = async (path, options) => {
    requests.push({ path, options });
    if (path.includes("/streams?")) return { value: [] };
    if (path.includes("/jobs/") && !options) return { properties: { status: "Completed" } };
    if (path.includes("/runbooks/")) return {};
    if (path.includes("/automationAccounts?")) return { value: [{ name: "after-party-runner", tags: { "after-party-runner": "true" } }] };
    return {};
  };
  const result = await runLab([
    "--lab", "payloads/tap-sign-in.ps1",
    "--capture-browser-page", "1"
  ], {
    loadConfig: async () => ({ config }),
    createClient: () => ({ requestJson, requestText: async () => "completed output" })
  });
  assert.equal(result.status, "Completed");
  const body = JSON.parse(requests.find(value => value.options?.method === "PUT").options.body);
  assert.deepEqual(body.properties.parameters, {
    LabPath: "payloads/tap-sign-in.ps1",
    SubscriptionId: subscriptionId,
    ResourceGroup: "after-test",
    CaptureBrowserPage: "1"
  });
});

test("refuses environment overrides and has no implicit interactive fallback", async () => {
  assert.deepEqual(argumentsFrom(["--lab", "payloads/send-email.ps1"]), { lab: "payloads/send-email.ps1" });
  await assert.rejects(runLab([
    "--lab", "payloads/send-email.ps1",
    "--resource-group", "another-group"
  ], {
    loadConfig: async () => ({ config }),
    createClient: () => { throw new Error("credential must not be created"); }
  }), /does not match/);
  const source = await readFile(new URL("../scripts/run-lab.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /InteractiveBrowserCredential|DeviceCodeCredential|AzureCliCredential|az login|execFile/);
  assert.match(source, /no browser will open/);
});

test("lists the authentication requirement for every supported workflow", () => {
  const table = renderWorkflowTable();
  assert.match(table, /npm run test:mocked\s+offline\s+never/);
  assert.match(table, /npm run arm:check\s+app-only ARM\s+never/);
  assert.match(table, /localhost:4173[\s\S]+human delegated/);
});

test("checks the expected ARM roles without changing a resource", async () => {
  const principalId = "55555555-5555-4555-8555-555555555555";
  const resourceGroupScope = `/subscriptions/${subscriptionId}/resourceGroups/after-test`;
  const accountScope = `${resourceGroupScope}/providers/Microsoft.Automation/automationAccounts/after-party-runner`;
  const requests = [];
  const requestJson = async path => {
    requests.push(path);
    if (path.includes("roleAssignments") && path.startsWith(accountScope)) return { value: [{ properties: { roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/d3881f73-407a-4167-8283-e981cbba0404" } }] };
    if (path.includes("roleAssignments") && path.startsWith(resourceGroupScope)) return { value: [
      { properties: { roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7" } },
      { properties: { roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/5d977122-f97e-4b4d-a52f-6b43003ddb4d" } }
    ] };
    if (path.includes("/runbooks/")) return {};
    if (path.includes("/automationAccounts?")) return { value: [{ name: "after-party-runner", tags: { "after-party-runner": "true" } }] };
    if (path.includes("containerGroups?")) return { value: [] };
    return {};
  };
  await checkArm([], {
    loadConfig: async () => ({ config, configPath: "/external/config.json", certificate: { validTo: "Jul 14 00:00:00 2027 GMT" } }),
    createClient: () => ({
      getToken: async () => token({ tid: tenantId, appid: clientId, oid: principalId }),
      requestJson
    })
  });
  assert.equal(requests.some(path => path.includes("/jobs/")), false);
  assert.equal(requests.filter(path => path.includes("roleAssignments")).length, 2);
});

test("standard development scripts contain no interactive credential fallback", async () => {
  const scripts = [
    "check-development-arm-auth.mjs",
    "development-arm-auth.mjs",
    "run-lab.mjs",
    "run-local-tap-sign-in.mjs"
  ];
  const sources = await Promise.all(scripts.map(name => readFile(new URL(`../scripts/${name}`, import.meta.url), "utf8")));
  assert.doesNotMatch(sources.join("\n"), /InteractiveBrowserCredential|DeviceCodeCredential|AzureCliCredential|az login/);
});
