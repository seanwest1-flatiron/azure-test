"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AfterPartyArmRetry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TRANSIENT_STATUSES = Object.freeze([408, 429, 500, 502, 503, 504]);
  const REPLAY_SAFE_METHODS = Object.freeze(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

  function isTransientArmFailure(error) {
    if (!error) return false;
    if (TRANSIENT_STATUSES.includes(Number(error.status))) return true;
    return error.name === "TypeError" || /failed to fetch|networkerror|network request failed|err_connection_reset|load failed/i.test(error.message || "");
  }

  function isReplaySafeMethod(method) {
    return REPLAY_SAFE_METHODS.includes(String(method || "GET").toUpperCase());
  }

  async function retryArmRequest(action, {
    method = "GET",
    attempts = 3,
    baseDelayMs = 200,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  } = {}) {
    const maximumAttempts = isReplaySafeMethod(method) ? Math.max(1, attempts) : 1;
    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        if (attempt === maximumAttempts || !isTransientArmFailure(error)) throw error;
        await sleep(baseDelayMs * (2 ** (attempt - 1)));
      }
    }
  }

  return Object.freeze({ TRANSIENT_STATUSES, isReplaySafeMethod, isTransientArmFailure, retryArmRequest });
});
