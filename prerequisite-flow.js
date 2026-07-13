"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AfterPartyPrerequisites = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function isRetryable(error) {
    if (!error || typeof error !== "object") return false;
    if (error.status) return [408, 429, 500, 502, 503, 504].includes(error.status);
    return error.name === "TypeError" || /network|fetch|temporarily unavailable/i.test(error.message || "");
  }

  async function retrySafe(action, { attempts = 2, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) } = {}) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try { return await action(); }
      catch (error) {
        if (attempt === attempts || !isRetryable(error)) throw error;
        await sleep(500 * attempt);
      }
    }
  }

  function createPrerequisiteFlow(dependencies) {
    let activeOperation = null;
    async function start(lab) {
      if (activeOperation) return { duplicate: true, activeOperation };
      activeOperation = lab.operation;
      try {
        dependencies.progress("Checking sign-in…");
        if (!dependencies.isSignedIn()) await dependencies.signIn(lab);
        dependencies.progress("Checking authorization…");
        await retrySafe(() => dependencies.ensureAuthorization(lab), dependencies.retryOptions);
        dependencies.progress("Checking environment…");
        await retrySafe(() => dependencies.restoreEnvironment(lab), dependencies.retryOptions);
        let runner = await retrySafe(() => dependencies.discoverRunner(lab), dependencies.retryOptions);
        if (!runner || runner.runnerVersion !== dependencies.runnerVersion()) {
          dependencies.progress(runner ? "Updating environment…" : "Creating environment…");
          runner = await dependencies.installRunner(lab, runner);
        }
        if (runner.tenantBaselineVersion !== dependencies.tenantBaselineVersion()) {
          dependencies.progress("Preparing tenant…");
          runner = await dependencies.prepareBaseline(lab, runner);
        }
        dependencies.progress("Starting lab…");
        await dependencies.startLab(lab, runner);
        return { started: true, runner };
      } finally {
        activeOperation = null;
      }
    }
    return Object.freeze({ start, get activeOperation() { return activeOperation; } });
  }

  return Object.freeze({ createPrerequisiteFlow, isRetryable, retrySafe });
});
