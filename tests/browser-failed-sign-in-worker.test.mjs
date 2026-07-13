import assert from "node:assert/strict";
import test from "node:test";

process.env.AFTER_PARTY_WORKER_TEST = "1";
const { boundedText, sanitizedUrl, collectPageDiagnostic, tenantUserPrincipalName, invalidPasswordForAlias } = await import("../payloads/browser-failed-sign-in-worker.mjs");

test("builds tenant-relative identities and one deterministic invalid password from the alias", () => {
  assert.equal(tenantUserPrincipalName("lisa.simpson", "student.onmicrosoft.com"), "lisa.simpson@student.onmicrosoft.com");
  assert.equal(invalidPasswordForAlias("lisa.simpson"), "bad-password-lisa.simpson");
  assert.equal(invalidPasswordForAlias("lisa.simpson"), invalidPasswordForAlias("lisa.simpson"));
});

test("browser diagnostics bound visible state and remove authorization query values", async () => {
  assert.equal(sanitizedUrl("https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?code=secret&state=state"), "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize");
  assert.equal(boundedText("Bearer secret-token https://example.test/?code=secret", 100), "Bearer [redacted] https://example.test/?code=[redacted]");

  const page = {
    url: () => "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?code=secret",
    title: async () => "Sign in to your account",
    locator: selector => ({
      innerText: async () => "AADSTS50126: Your account or password is incorrect.",
      evaluateAll: async callback => callback(selector === "input:visible"
        ? [{ getAttribute: name => ({ type: "email", name: "loginfmt", "aria-label": "Email, phone, or Skype" }[name]), id: "i0116" }]
        : [{ getAttribute: name => ({ type: "submit", "aria-label": "Next" }[name]), value: "", innerText: "" }])
    })
  };
  const diagnostic = await collectPageDiagnostic(page, {
    lastCompletedStage: "username_submitted",
    usernameSubmissionAttempted: true,
    passwordSubmissionAttempted: false,
    consoleMessages: [],
    requestFailures: []
  });

  assert.equal(diagnostic.lastCompletedStage, "username_submitted");
  assert.equal(diagnostic.finalUrl, "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize");
  assert.equal(diagnostic.microsoftErrorCode, "AADSTS50126");
  assert.match(diagnostic.rejectionText, /password is incorrect/i);
  assert.deepEqual(diagnostic.visibleInputs, [{ type: "email", name: "loginfmt", label: "Email, phone, or Skype" }]);
  assert.deepEqual(diagnostic.visibleButtons, [{ type: "submit", label: "Next" }]);
});
