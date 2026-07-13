import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createPrerequisiteFlow } = require("../prerequisite-flow.js");
const lab = { operation: "sendEmail", label: "Email" };

function dependencies(overrides = {}) {
  const ready = { runnerVersion: "runner-2", tenantBaselineVersion: "baseline-2" };
  return {
    isSignedIn: () => true,
    signIn: async () => {},
    ensureAuthorization: async () => {},
    restoreEnvironment: async () => {},
    discoverRunner: async () => ready,
    installRunner: async () => ready,
    prepareBaseline: async (selectedLab, runner) => ({ ...runner, tenantBaselineVersion: "baseline-2" }),
    startLab: async () => {},
    runnerVersion: () => "runner-2",
    tenantBaselineVersion: () => "baseline-2",
    progress: () => {},
    retryOptions: { attempts: 2, sleep: async () => {} },
    ...overrides
  };
}

test("resumes the selected lab after redirect sign-in", async () => {
  let signedIn = false;
  let pending;
  let starts = 0;
  const redirect = new Error("redirecting");
  const flow = createPrerequisiteFlow(dependencies({
    isSignedIn: () => signedIn,
    signIn: async selectedLab => { pending = selectedLab; throw redirect; },
    startLab: async () => { starts += 1; }
  }));

  await assert.rejects(flow.start(lab), redirect);
  signedIn = true;
  await flow.start(pending);
  assert.equal(starts, 1);
});

test("updates a stale runner before starting the lab", async () => {
  let installs = 0;
  let starts = 0;
  const flow = createPrerequisiteFlow(dependencies({
    discoverRunner: async () => ({ runnerVersion: "runner-1", tenantBaselineVersion: "baseline-2" }),
    installRunner: async () => { installs += 1; return { runnerVersion: "runner-2", tenantBaselineVersion: "baseline-2" }; },
    startLab: async () => { starts += 1; }
  }));

  await flow.start(lab);
  assert.equal(installs, 1);
  assert.equal(starts, 1);
});

test("prepares a stale tenant baseline before starting the lab", async () => {
  let preparations = 0;
  const flow = createPrerequisiteFlow(dependencies({
    discoverRunner: async () => ({ runnerVersion: "runner-2", tenantBaselineVersion: "baseline-1" }),
    prepareBaseline: async (selectedLab, runner) => { preparations += 1; return { ...runner, tenantBaselineVersion: "baseline-2" }; }
  }));

  await flow.start(lab);
  assert.equal(preparations, 1);
});

test("uses the ready-environment fast path", async () => {
  let installs = 0;
  let preparations = 0;
  let starts = 0;
  const flow = createPrerequisiteFlow(dependencies({
    installRunner: async () => { installs += 1; },
    prepareBaseline: async () => { preparations += 1; },
    startLab: async () => { starts += 1; }
  }));

  await flow.start(lab);
  assert.deepEqual({ installs, preparations, starts }, { installs: 0, preparations: 0, starts: 1 });
});

test("does not start a duplicate lab while prerequisites are active", async () => {
  let release;
  let starts = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const flow = createPrerequisiteFlow(dependencies({
    restoreEnvironment: async () => blocked,
    startLab: async () => { starts += 1; }
  }));

  const first = flow.start(lab);
  const second = await flow.start(lab);
  assert.equal(second.duplicate, true);
  release();
  await first;
  assert.equal(starts, 1);
});
