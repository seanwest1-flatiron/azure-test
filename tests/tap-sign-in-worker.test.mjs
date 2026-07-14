import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

process.env.AFTER_PARTY_WORKER_TEST = "1";
process.env.TEMPORARY_ACCESS_PASS = "secret-tap-value";
const { CONSENT_SUBMIT_FALLBACK_SELECTOR, TAP_INPUT_SELECTOR, TAP_SUBMIT_FALLBACK_SELECTOR, base64Url, buildAuthorizeUrl, clickAccountSelection, clickConsentAccept, clickTapSignIn, createCallbackObserver, createPkce, credentialEntryStage, decodeJwtClaim, diagnosticUrl, isAccountSelectionPage, isPermissionsRequestedPage, isRegistrationInterruption, outcomeFromUrl, runTapSignIn, safeText, tenantUserPrincipalName } = await import("../payloads/tap-sign-in-worker.mjs");

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

test("builds an isolated interactive authorization request with PKCE", () => {
  const url = buildAuthorizeUrl({
    tenantId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
    upn: "lisa.simpson@student.onmicrosoft.com",
    state: "expected-state",
    challenge: "expected-challenge"
  });
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost");
  assert.equal(url.searchParams.get("prompt"), "login");
  assert.equal(url.searchParams.get("login_hint"), "lisa.simpson@student.onmicrosoft.com");
  assert.equal(url.searchParams.get("scope"), "openid profile https://graph.microsoft.com/User.Read");
  assert.equal(url.searchParams.get("code_challenge"), "expected-challenge");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("validates callback state for authorization codes and OAuth errors", () => {
  assert.deepEqual(outcomeFromUrl("http://localhost/?code=code&state=expected", "http://localhost", "expected"), { kind: "code", code: "code" });
  assert.deepEqual(outcomeFromUrl("http://localhost/?error=access_denied&error_description=Denied&state=expected", "http://localhost", "expected"), { kind: "error", message: "access_denied: Denied" });
  assert.deepEqual(outcomeFromUrl("http://localhost/?error=access_denied&state=wrong", "http://localhost", "expected"), { kind: "error", message: "The OAuth state value did not match." });
  assert.equal(outcomeFromUrl("https://login.microsoftonline.com/", "http://localhost", "expected"), null);
});

function callbackContext() {
  const listeners = new Map();
  let routeRegistration;
  return {
    on(event, handler) { listeners.set(event, handler); },
    async route(predicate, handler) { routeRegistration = { predicate, handler }; },
    emit(event, value) { listeners.get(event)?.(value); },
    get routeRegistration() { return routeRegistration; }
  };
}

test("captures a context request before localhost becomes a failed navigation page", async () => {
  const context = callbackContext();
  const observer = await createCallbackObserver(context, "http://localhost", "expected", { fulfillCallback: false });
  context.emit("request", { url: () => "http://localhost/?code=early-code&state=expected" });
  context.emit("framenavigated", { url: () => "chrome-error://chromewebdata/" });
  assert.deepEqual(observer.getOutcome(), { kind: "code", code: "early-code" });
  assert.equal(context.routeRegistration, undefined);
});

test("captures a context navigation fallback from any page or popup", async () => {
  const context = callbackContext();
  const observer = await createCallbackObserver(context, "http://localhost", "expected", { fulfillCallback: false });
  context.emit("request", { url: () => "https://login.microsoftonline.com/authorize" });
  assert.equal(observer.getOutcome(), null);
  context.emit("framenavigated", { url: () => "http://localhost/?code=frame-code&state=expected" });
  assert.deepEqual(observer.getOutcome(), { kind: "code", code: "frame-code" });
});

test("retains the callback when optional route fulfillment fails", async () => {
  const checkpoints = [];
  const context = callbackContext();
  const observer = await createCallbackObserver(context, "http://localhost", "expected", { checkpoint: (...value) => checkpoints.push(value) });
  const callback = "http://localhost/?code=route-code&state=expected";
  assert.equal(context.routeRegistration.predicate(new URL(callback)), true);
  await context.routeRegistration.handler({
    request: () => ({ url: () => callback }),
    fulfill: async () => { throw new Error("Chromium rejected fulfillment"); },
    abort: async () => {}
  });
  assert.deepEqual(observer.getOutcome(), { kind: "code", code: "route-code" });
  assert.deepEqual(checkpoints, [["callback-fulfillment", "failed-after-capture"]]);
});

test("treats account selection as optional and selects Lisa or another account", async () => {
  assert.equal(isAccountSelectionPage("Pick an account"), true);
  assert.equal(isAccountSelectionPage("Enter password"), false);
  const clicks = [];
  const pageWithLisa = {
    getByText(value) {
      const isLisa = typeof value === "string";
      return { first: () => ({ isVisible: async () => isLisa, click: async () => clicks.push(isLisa ? "lisa" : "other") }) };
    }
  };
  assert.equal(await clickAccountSelection(pageWithLisa, "lisa.simpson@student.onmicrosoft.com"), "target");
  assert.deepEqual(clicks, ["lisa"]);

  const pageWithOther = {
    getByText(value) {
      const isOther = value instanceof RegExp;
      return { first: () => ({ isVisible: async () => isOther, click: async () => clicks.push("other") }) };
    }
  };
  assert.equal(await clickAccountSelection(pageWithOther, "lisa.simpson@student.onmicrosoft.com"), "other");
  assert.deepEqual(clicks, ["lisa", "other"]);
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

test("recognizes the permissions request and accepts it with the accessible button", async () => {
  assert.equal(isPermissionsRequestedPage("Permissions requested After Party Failed Sign-In Generator"), true);
  assert.equal(isPermissionsRequestedPage("Welcome"), false);
  const clicks = [];
  const page = {
    getByRole(role, options) {
      assert.equal(role, "button");
      assert.equal(String(options.name), "/^Accept$/i");
      return { first: () => ({ isVisible: async () => true, click: async () => clicks.push("accessible") }) };
    },
    locator() {
      return { first: () => ({ isVisible: async () => true, click: async () => clicks.push("fallback") }) };
    }
  };
  assert.equal(await clickConsentAccept(page), true);
  assert.deepEqual(clicks, ["accessible"]);
});

test("falls back to a visible submit control when the accessible Accept button is unavailable", async () => {
  const clicks = [];
  const page = {
    getByRole() {
      return { first: () => ({ isVisible: async () => false, click: async () => clicks.push("accessible") }) };
    },
    locator(selector) {
      assert.equal(selector, CONSENT_SUBMIT_FALLBACK_SELECTOR);
      return { first: () => ({ isVisible: async () => true, click: async () => clicks.push("fallback") }) };
    }
  };
  assert.equal(await clickConsentAccept(page), true);
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

test("captures each recognized page state once while masking visible inputs", () => {
  const source = readFileSync(new URL("../payloads/tap-sign-in-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /capturedPageStates\.has\(state\)/);
  assert.match(source, /emitPageCapture\(page, "temporary-access-pass"\)/);
  assert.match(source, /emitPageCapture\(page, "permissions-requested"\)/);
  assert.match(source, /mask: \[page\.locator\("input:visible, textarea:visible"\)\]/);
  assert.doesNotMatch(source, /element\.value = ""/);
});

test("uses a fresh nonpersistent browser context and intercepts its own localhost callback", () => {
  const source = readFileSync(new URL("../payloads/tap-sign-in-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /browser\.newContext\(\)/);
  assert.match(source, /context\.on\("request"/);
  assert.match(source, /context\.on\("framenavigated"/);
  assert.match(source, /context\.route\(url => sameCallbackEndpoint/);
  assert.doesNotMatch(source, /launchPersistentContext|userDataDir|storageState/);
});

test("completes the reusable browser callback, token exchange, and Graph me flow with mocks", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  let stage = "username";
  let currentUrl = "about:blank";
  const contextListeners = new Map();
  let contextCloseCount = 0;
  let browserCloseCount = 0;
  const locator = selector => {
    if (selector === "body") return { innerText: async () => "Sign in" };
    if (selector === 'input[name="loginfmt"]:visible') return {
      isVisible: async () => stage === "username",
      fill: async value => assert.equal(value, "lisa.simpson@student.onmicrosoft.com")
    };
    if (selector === "#idSIButton9") return { click: async () => { stage = "tap"; } };
    if (selector === TAP_INPUT_SELECTOR) return { first: () => ({
      isVisible: async () => stage === "tap",
      fill: async value => assert.equal(value, "one-time-secret")
    }) };
    throw new Error(`Unexpected locator: ${selector}`);
  };
  const page = {
    locator,
    url: () => currentUrl,
    route: async (predicate, handler) => { routePredicate = predicate; routeHandler = handler; },
    goto: async value => { currentUrl = value; },
    getByRole: () => ({ first: () => ({
      isVisible: async () => true,
      click: async () => {
        const state = new URL(currentUrl).searchParams.get("state");
        const callback = `http://localhost/?code=authorization-code&state=${state}`;
        contextListeners.get("request")({ url: () => callback });
        currentUrl = "chrome-error://chromewebdata/";
      }
    }) })
  };
  const browser = {
    newContext: async () => ({
      on: (event, handler) => contextListeners.set(event, handler),
      route: async () => {},
      newPage: async () => page,
      close: async () => { contextCloseCount += 1; }
    }),
    close: async () => { browserCloseCount += 1; }
  };
  const launches = [];
  const chromium = { launch: async options => { launches.push(options); return browser; } };
  const tokenPayload = Buffer.from(JSON.stringify({ tid: tenantId })).toString("base64url");
  const fetchCalls = [];
  const fetchImpl = async url => {
    fetchCalls.push(String(url));
    if (String(url).includes("/token")) return new Response(JSON.stringify({ access_token: `header.${tokenPayload}.signature` }), { status: 200 });
    return new Response(JSON.stringify({ displayName: "Lisa Simpson", userPrincipalName: "lisa.simpson@student.onmicrosoft.com" }), { status: 200 });
  };

  const result = await runTapSignIn({
    tenantId,
    tenantDomain: "student.onmicrosoft.com",
    clientId: "22222222-2222-4222-8222-222222222222",
    userAlias: "lisa.simpson",
    temporaryAccessPass: "one-time-secret",
    headless: false
  }, { chromium, fetchImpl });

  assert.equal(result.result, "confirmed");
  assert.deepEqual(launches, [{ headless: false }]);
  assert.equal(contextCloseCount, 1);
  assert.equal(browserCloseCount, 1);
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1], /graph\.microsoft\.com\/v1\.0\/me/);
});
