import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPrerequisiteFlow } = require("../prerequisite-flow.js");
const [index, app, template, styles, seed] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8"),
  readFile(new URL("../azuredeploy.json", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../payloads/tenant-seed.json", import.meta.url), "utf8").then(JSON.parse)
]);

test("environment updates publish the cache-busted bootstrap runbook", () => {
  assert.match(app, /bootstrapUri: \{ value: `\$\{config\.repositoryRawBase\}\/runbooks\/bootstrap\.ps1\?version=\$\{encodeURIComponent\(buildVersion\("runnerVersion"\)\)\}` \}/);
  assert.match(template, /"publishContentLink": \{[\s\S]*?"uri": "\[parameters\('bootstrapUri'\)\]"/);
});

test("hides the application until the versioned stylesheet loads and reveals loader failures", () => {
  assert.ok(index.indexOf('id="critical-loading-style"') < index.indexOf("</head>"));
  assert.match(index, /body > main \{ visibility: hidden; \}/);
  assert.match(index, /await addStylesheet\(`styles\.css\?v=\$\{version\}`\);\s*document\.documentElement\.classList\.add\("styles-ready"\)/);
  assert.match(index, /showLoaderError[\s\S]*classList\.add\("styles-failed"\)/);
  assert.match(index, /html\.styles-failed #status/);
});

test("uses one compact global status and keeps detailed prerequisite progress on the selected lab", () => {
  assert.equal((index.match(/id="status"/g) || []).length, 1);
  assert.doesNotMatch(index, /id="environment-status"/);
  assert.doesNotMatch(app, /environment-status/);
  assert.match(app, /setStatus\("Environment check in progress\."\)/);
  assert.match(app, /setJobStatus\(prerequisiteStatusElement, message, "queued"\)/);
});

test("keeps the lab spinner animated while prerequisite stages continue", async () => {
  const progress = [];
  const flow = createPrerequisiteFlow({
    isSignedIn: () => true,
    signIn: async () => {},
    ensureAuthorization: async () => {},
    restoreEnvironment: async () => {},
    discoverRunner: async () => ({ runnerVersion: "old", tenantBaselineVersion: "old" }),
    installRunner: async () => ({ runnerVersion: "current", tenantBaselineVersion: "old" }),
    prepareBaseline: async (lab, runner) => ({ ...runner, tenantBaselineVersion: "current" }),
    startLab: async () => {},
    runnerVersion: () => "current",
    tenantBaselineVersion: () => "current",
    progress: message => progress.push(message),
    retryOptions: { attempts: 1 }
  });

  await flow.start({ operation: "lab", label: "Lab" });
  assert.deepEqual(progress, ["Checking sign-in…", "Checking authorization…", "Checking environment…", "Updating environment…", "Preparing tenant…", "Starting lab…"]);
  assert.match(styles, /\.job-status\.queued::before, \.job-status\.running::before[\s\S]*animation: after-party-spin \.75s linear infinite/);
  assert.match(styles, /@keyframes after-party-spin/);
  assert.match(app, /\$\{label\}: \$\{status\.toLowerCase\(\)\}…/);
});

test("lab descriptions use seeded display names without the tenant domain", () => {
  const names = new Set(seed.users.map(user => user.displayName));
  for (const expected of ["Kobe West", "Cory West", "Lisa Simpson"]) assert.ok(names.has(expected));
  assert.match(index, /Kobe West/);
  assert.match(index, /Cory West/);
  assert.match(index, /Lisa Simpson/);
  assert.doesNotMatch(index, /@corywest\.onmicrosoft\.com/i);
});

test("wires the three non-interactive failed sign-ins card to the existing ROPC payload", () => {
  assert.match(index, /<h2>Three non-interactive failed sign-ins<\/h2>/);
  assert.match(index, /Submits three incorrect-password sign-ins for Lisa Simpson without using a browser\./);
  assert.match(app, /failedSignInThree: \{[\s\S]*?operation: "failedSignInThree"[\s\S]*?payloadPath: "payloads\/failed-sign-in\.ps1"[\s\S]*?parameters: Object\.freeze\(\{ AttemptCount: "3" \}\)/);
  assert.match(app, /bind\("run-failed-sign-in-three", "click", \(\) => handleAction\(\(\) => beginLab\("failedSignInThree"\)\)\)/);
});
