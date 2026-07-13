import test from "node:test";
import assert from "node:assert/strict";
import { RUNNER_AFFECTING_FILES, runnerAffectingFiles, validateRunnerVersionChange } from "../scripts/check-runner-version.mjs";

const manifest = runnerVersion => ({ runnerVersion });

test("requires a runner version bump for every deployed runner artifact", () => {
  for (const file of RUNNER_AFFECTING_FILES) {
    assert.throws(() => validateRunnerVersionChange({
      changedFiles: [file],
      previousManifest: manifest("runner-1"),
      currentManifest: manifest("runner-1")
    }), /without changing version\.json runnerVersion/);
  }
});

test("accepts runner changes accompanied by a runner version bump", () => {
  assert.doesNotThrow(() => validateRunnerVersionChange({
    changedFiles: ["runbooks/bootstrap.ps1", "version.json"],
    previousManifest: manifest("runner-1"),
    currentManifest: manifest("runner-2")
  }));
});

test("requires a runner version bump for runner configuration changes in the frontend", () => {
  assert.throws(() => validateRunnerVersionChange({
    changedFiles: ["app.js"],
    changedAppLines: ["const APPLICATION_ROLES = Object.freeze([\"CustomDetection.ReadWrite.All\"]);"],
    previousManifest: manifest("runner-1"),
    currentManifest: manifest("runner-1")
  }), /app\.js/);
  assert.deepEqual(runnerAffectingFiles({ changedFiles: ["app.js"], changedAppLines: ["setStatus(\"Ready\");"] }), []);
});

test("treats managed-identity permission reconciliation as runner-affecting", () => {
  for (const changedLine of [
    'const CORE_APPLICATION_ROLES = Object.freeze(["Application.ReadWrite.All"]);',
    "async function reconcileRunnerPermissions(lab, runner) {"
  ]) {
    assert.throws(() => validateRunnerVersionChange({
      changedFiles: ["app.js"],
      changedAppLines: [changedLine],
      previousManifest: manifest("runner-1"),
      currentManifest: manifest("runner-1")
    }), /app\.js/);
  }
});

test("does not require runner changes for payload, baseline, or frontend-only edits", () => {
  for (const file of ["payloads/failed-sign-in.ps1", "payloads/tenant-seed.json", "app.js", "index.html", "styles.css"]) {
    assert.doesNotThrow(() => validateRunnerVersionChange({
      changedFiles: [file],
      previousManifest: manifest("runner-1"),
      currentManifest: manifest("runner-1")
    }));
  }
});
