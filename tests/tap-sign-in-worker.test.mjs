import assert from "node:assert/strict";
import test from "node:test";

process.env.AFTER_PARTY_WORKER_TEST = "1";
process.env.TEMPORARY_ACCESS_PASS = "secret-tap-value";
const { TAP_INPUT_SELECTOR, TAP_SUBMIT_FALLBACK_SELECTOR, base64Url, clickTapSignIn, createPkce, credentialEntryStage, decodeJwtClaim, diagnosticUrl, isRegistrationInterruption, safeText, tenantUserPrincipalName } = await import("../payloads/tap-sign-in-worker.mjs");

test("builds Lisa's UPN from the connected tenant domain", () => {
  assert.equal(tenantUserPrincipalName("lisa.simpson", "student.onmicrosoft.com"), "lisa.simpson@student.onmicrosoft.com");
  assert.throws(() => tenantUserPrincipalName("cory west", "student.onmicrosoft.com"));
});

test("creates an S256-compatible PKCE verifier and challenge without retaining a client secret", () => {
  const first = createPkce();
  const second = createPkce();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.verifier, second.verifier);
  assert.equal(base64Url(Buffer.from("hello")), "aGVsbG8");
});

test("detects security-information and MFA registration interruption", () => {
  assert.equal(isRegistrationInterruption("https://mysignins.microsoft.com/security-info", ""), true);
  assert.equal(isRegistrationInterruption("https://login.microsoftonline.com/", "More information required"), true);
  assert.equal(isRegistrationInterruption("http://localhost/?code=redacted", "You signed in"), false);
});

test("accepts Microsoft's direct TAP screen when login_hint hides the username field", () => {
  assert.match(TAP_INPUT_SELECTOR, /input\[name="accesspass"\]:visible/);
  assert.equal(credentialEntryStage({ usernameVisible: false, tapVisible: true }), "tap");
  assert.equal(credentialEntryStage({ usernameVisible: true, tapVisible: false }), "username");
  assert.equal(credentialEntryStage({ usernameVisible: false, tapVisible: false }), "pending");
});

test("submits the TAP with the accessible Sign in button when available", async () => {
  const clicks = [];
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(String(options.name), "/^Sign in$/i");
      return { first: () => ({ isVisible: async () => true, click: async () => clicks.push("accessible") }) };
    },
    locator() {
      return { first: () => ({ click: async () => clicks.push("fallback") }) };
    }
  };
  await clickTapSignIn(page);
  assert.deepEqual(clicks, ["accessible"]);
});

test("falls back to a visible submit control when the accessible Sign in button is unavailable", async () => {
  const clicks = [];
  const page = {
    getByRole() {
      return { first: () => ({ isVisible: async () => false, click: async () => clicks.push("accessible") }) };
    },
    locator(selector) {
      assert.equal(selector, TAP_SUBMIT_FALLBACK_SELECTOR);
      return { first: () => ({ click: async () => clicks.push("fallback") }) };
    }
  };
  await clickTapSignIn(page);
  assert.deepEqual(clicks, ["fallback"]);
});

test("redacts TAP and OAuth artifacts and validates the delegated tenant claim", () => {
  assert.equal(safeText("secret-tap-value Bearer token https://localhost/?code=secret&refresh_token=refresh"), "[redacted] Bearer [redacted] https://localhost/?code=[redacted]&refresh_token=[redacted]");
  const payload = Buffer.from(JSON.stringify({ tid: "expected-tenant-id" })).toString("base64url");
  assert.equal(decodeJwtClaim(`header.${payload}.signature`, "tid"), "expected-tenant-id");
});

test("removes query strings and fragments from captured page locations", () => {
  assert.equal(diagnosticUrl("https://login.microsoftonline.com/tenant/login?code=secret#fragment"), "https://login.microsoftonline.com/tenant/login");
  assert.equal(diagnosticUrl("not a url"), "unavailable");
});
