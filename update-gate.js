"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AfterPartyUpdateGate = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function normalizedCommit(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function cacheBustedUrl(currentUrl, nonce = Date.now()) {
    const url = new URL(currentUrl);
    url.searchParams.set("refresh", String(nonce));
    return url.toString();
  }

  function createUpdateGate({ loadedCommit, getDeployedCommit, promptForRefresh, refresh }) {
    const loaded = normalizedCommit(loadedCommit);
    if (!loaded) throw new Error("The loaded frontend commit is unavailable.");
    let pendingDecision = null;
    let refreshStarted = false;

    async function check() {
      if (refreshStarted) return false;
      if (pendingDecision) return pendingDecision;
      pendingDecision = (async () => {
        const deployed = normalizedCommit(await getDeployedCommit());
        if (!deployed) throw new Error("The deployed frontend commit is unavailable.");
        if (deployed === loaded) return true;
        const decision = await promptForRefresh();
        if (decision === "refresh" && !refreshStarted) {
          refreshStarted = true;
          refresh();
        }
        return false;
      })();
      try {
        return await pendingDecision;
      } finally {
        pendingDecision = null;
      }
    }

    return Object.freeze({ check, get refreshStarted() { return refreshStarted; } });
  }

  return Object.freeze({ cacheBustedUrl, createUpdateGate, normalizedCommit });
});
