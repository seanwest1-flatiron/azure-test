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

test("keeps delegated admin scopes separate from managed-identity application roles", () => {
  assert.match(app, /const GRAPH_SCOPES = \["Application\.Read\.All", "AppRoleAssignment\.ReadWrite\.All"\]/);
  assert.match(app, /"CustomDetection\.ReadWrite\.All"/);
  assert.match(app, /"Domain\.Read\.All"/);
  assert.match(app, /"Application\.ReadWrite\.All"/);
  assert.doesNotMatch(app, /const GRAPH_SCOPES = \[[^\]]*Application\.ReadWrite\.All/);
  assert.match(app, /LAB_APPLICATION_ROLES = Object\.freeze\(\{ failedSignInDetection: Object\.freeze\(\["CustomDetection\.ReadWrite\.All"\]\) \}\)/);
  assert.doesNotMatch(app, /CORE_APPLICATION_ROLES = Object\.freeze\(\[[^\]]*CustomDetection\.ReadWrite\.All/);
});

test("reconciles required managed-identity roles for an existing environment", () => {
  assert.match(app, /async function reconcileRunnerPermissions\(lab, runner\)/);
  assert.match(app, /await grantApplicationPermissions\(principalId, lab\.operation, applicationRolesForOperation\(lab\.operation\)\)/);
  assert.match(app, /reconcilePermissions: reconcileRunnerPermissions/);
  assert.match(app, /addedRoles\.length/);
  assert.match(index, /runner-permissions\.js\?v=\$\{version\}/);
});

test("hides the application until the versioned stylesheet loads and reveals loader failures", () => {
  assert.ok(index.indexOf('id="critical-loading-style"') < index.indexOf("</head>"));
  assert.match(index, /body > main \{ visibility: hidden; \}/);
  assert.match(index, /await addStylesheet\(`styles\.css\?v=\$\{version\}`\);\s*document\.documentElement\.classList\.add\("styles-ready"\)/);
  assert.match(index, /showLoaderError[\s\S]*classList\.add\("styles-failed"\)/);
  assert.match(index, /showLoaderError[\s\S]*status\.hidden = false/);
  assert.match(index, /html\.styles-failed #status/);
});

test("keeps the global status quiet when idle and progress on the selected lab", () => {
  assert.equal((index.match(/id="status"/g) || []).length, 1);
  assert.doesNotMatch(index, /id="environment-status"/);
  assert.doesNotMatch(app, /environment-status/);
  assert.match(index, /id="status"[^>]*hidden/);
  assert.doesNotMatch(app, /Ready to sign in|Environment check in progress/);
  assert.match(app, /else clearStatus\(\)/);
  assert.match(app, /setJobStatus\(prerequisiteStatusElement, message, "queued"\)/);
  assert.match(app, /error\.afterPartyLabReported = true/);
  assert.match(app, /!error\?\.afterPartyLabReported/);
  assert.match(app, /could not start because its prerequisites did not complete/);
  assert.match(app, /details\.className = "job-technical-details"/);
  assert.match(app, /summary\.textContent = "Technical details"/);
  assert.match(styles, /\.job-technical-details/);
});

test("puts authentication in a responsive account control", () => {
  assert.match(index, /<header class="site-header">[\s\S]*?id="sign-in"[\s\S]*?Sign in with Microsoft/);
  assert.match(index, /<details id="account-menu" class="account-menu" hidden>[\s\S]*?id="account-button"[\s\S]*?id="account-environment"[\s\S]*?id="sign-out"/);
  assert.match(app, /el\["account-button"\]\.textContent = displayName/);
  assert.match(app, /el\["account-menu"\]\.hidden = !signedIn/);
  assert.match(styles, /\.account-control \{ position: relative/);
  assert.match(styles, /button:focus-visible, summary:focus-visible, select:focus-visible/);
  assert.match(styles, /@media \(max-width: 620px\)[\s\S]*?\.site-header \{[^}]*flex-direction: column/);
});

test("uses a transient environment chooser and removes manual setup controls", () => {
  assert.match(index, /<dialog id="environment-chooser"[^>]*aria-labelledby="environment-chooser-title"[^>]*aria-describedby="environment-chooser-message"/);
  assert.match(index, /id="subscription-field"[\s\S]*?id="subscription"[\s\S]*?id="resource-group-field" hidden[\s\S]*?id="resource-group"/);
  assert.doesNotMatch(index, /Environment details|Authorize Azure and load subscriptions|Repair or update environment|Reapply tenant baseline/);
  assert.doesNotMatch(index, /id="authorize-azure"|id="install"|id="run-tenant-seed"/);
  assert.match(app, /storedSubscription[\s\S]*?subscriptionOptions\.length === 1[\s\S]*?await chooseEnvironmentOption/);
  assert.match(app, /storedGroup[\s\S]*?groupOptions\.length === 1[\s\S]*?await chooseEnvironmentOption/);
  assert.match(app, /will continue automatically after you choose/);
  assert.doesNotMatch(app, /select the lab again/);
});

test("keeps read-only environment diagnostics in closed technical details", () => {
  assert.match(index, /<details class="technical-details">[\s\S]*?<summary>Technical details<\/summary>[\s\S]*?id="diagnostics"/);
  assert.doesNotMatch(index, /<details class="technical-details" open/);
  for (const label of ["Site", "Desired runner", "Detected runner", "Desired baseline", "Applied baseline", "Subscription", "Resource group", "Automation account", "Deployed commit", "Deployment time"]) {
    assert.match(app, new RegExp(`${label}:`));
  }
});

test("redirect completion still resumes the originally selected lab", () => {
  assert.match(app, /savePendingOperation\(lab\.operation\)[\s\S]*?loginRedirect/);
  assert.match(app, /if \(pending && redirectResult\) await resumePendingOperation\(pending\)/);
  assert.match(app, /if \(labs\[pending\.operation\]\) return await beginLab\(pending\.operation, pending\.form\)/);
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
    reconcilePermissions: async (lab, runner) => runner,
    prepareBaseline: async (lab, runner) => ({ ...runner, tenantBaselineVersion: "current" }),
    startLab: async () => {},
    runnerVersion: () => "current",
    tenantBaselineVersion: () => "current",
    progress: message => progress.push(message),
    retryOptions: { attempts: 1 }
  });

  await flow.start({ operation: "lab", label: "Lab" });
  assert.deepEqual(progress, ["Checking sign-in…", "Checking authorization…", "Checking environment…", "Updating environment…", "Checking runner permissions…", "Preparing tenant…", "Starting lab…"]);
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

test("places the dedicated failed sign-in detection lab after the three-attempt non-interactive lab", () => {
  const threeAttemptCard = index.indexOf("<h2>Three non-interactive failed sign-ins</h2>");
  const detectionCard = index.indexOf("<h2>Create failed sign-in detection</h2>");
  const browserCard = index.indexOf("<h2>Three browser failed sign-ins</h2>");
  assert.ok(threeAttemptCard >= 0 && detectionCard > threeAttemptCard && browserCard > detectionCard);
  assert.match(app, /failedSignInDetection: \{[^}]*operation: "failedSignInDetection"[^}]*payloadPath: "payloads\/create-failed-sign-in-detection\.ps1"/);
  assert.match(app, /bind\("run-failed-sign-in-detection", "click", \(\) => handleAction\(\(\) => beginLab\("failedSignInDetection"\)\)\)/);
});
