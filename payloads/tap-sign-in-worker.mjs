import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RESULT_PREFIX = "TAP_SIGN_IN_RESULT ";
const DEFAULT_REDIRECT_URI = "http://localhost";
const DEFAULT_SCOPE = "openid profile https://graph.microsoft.com/User.Read";

export const TAP_INPUT_SELECTOR = 'input[name="accesspass"]:visible, input[name="passwd"]:visible, input[name="otc"]:visible, #idTxtBx_SAOTCC_OTC:visible';
export const TAP_SUBMIT_FALLBACK_SELECTOR = 'button[type="submit"]:visible, input[type="submit"]:visible, #idSIButton9:visible';
export const CONSENT_SUBMIT_FALLBACK_SELECTOR = 'button[type="submit"]:visible, input[type="submit"]:visible, #idSIButton9:visible';

const wait = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds));

export function base64Url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function createPkce() {
  const verifier = base64Url(randomBytes(64));
  return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) };
}

export function tenantUserPrincipalName(alias, domain) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias || "") || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain || "")) {
    throw new Error("Tenant-relative user configuration is invalid.");
  }
  return `${alias}@${domain}`;
}

export function safeText(value, maximumLength = 500, secrets = [process.env.TEMPORARY_ACCESS_PASS]) {
  let text = String(value || "")
    .replace(/([?&#](?:code|access_token|id_token|refresh_token|client_info)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ").trim();
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[redacted]");
  return text.length > maximumLength ? `${text.slice(0, maximumLength)}…` : text;
}

export function isRegistrationInterruption(url, pageText) {
  return /(?:mysignins\.microsoft\.com\/security-info|aka\.ms\/mfasetup)/i.test(url || "") ||
    /(?:more information required|keep your account secure|set up your account|security info|microsoft authenticator|add (?:a )?sign-in method)/i.test(pageText || "");
}

export function isAccountSelectionPage(pageText) {
  return /(?:pick|choose|select) an account|use another account|sign in with another account/i.test(pageText || "");
}

export function decodeJwtClaim(token, claim) {
  const segment = String(token || "").split(".")[1];
  if (!segment) throw new Error("The delegated access token was not a valid JWT.");
  const payload = JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return payload[claim];
}

export function credentialEntryStage({ usernameVisible, tapVisible }) {
  if (tapVisible) return "tap";
  if (usernameVisible) return "username";
  return "pending";
}

export async function clickTapSignIn(page) {
  const accessibleSignIn = page.getByRole("button", { name: /^Sign in$/i }).first();
  if (await accessibleSignIn.isVisible().catch(() => false)) {
    await accessibleSignIn.click();
    return;
  }
  await page.locator(TAP_SUBMIT_FALLBACK_SELECTOR).first().click();
}

export async function clickAccountSelection(page, upn) {
  const account = page.getByText(upn, { exact: false }).first();
  if (await account.isVisible().catch(() => false)) {
    await account.click();
    return "target";
  }
  const anotherAccount = page.getByText(/use another account|sign in with another account/i).first();
  if (await anotherAccount.isVisible().catch(() => false)) {
    await anotherAccount.click();
    return "other";
  }
  return "unhandled";
}

export function isPermissionsRequestedPage(pageText) {
  return /permissions requested|accept the permissions request/i.test(pageText || "");
}

export async function clickConsentAccept(page) {
  const accessibleAccept = page.getByRole("button", { name: /^Accept$/i }).first();
  if (await accessibleAccept.isVisible().catch(() => false)) {
    await accessibleAccept.click();
    return true;
  }
  const fallback = page.locator(CONSENT_SUBMIT_FALLBACK_SELECTOR).first();
  if (await fallback.isVisible().catch(() => false)) {
    await fallback.click();
    return true;
  }
  return false;
}

export function diagnosticUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch { return "unavailable"; }
}

function defaultResultReporter(result) {
  console.log(`${RESULT_PREFIX}${JSON.stringify({ ...result, timestampUtc: new Date().toISOString() })}`);
}

function defaultDiagnosticReporter({ diagnostic, screenshot }) {
  console.log(`TAP_PAGE_DIAGNOSTIC ${JSON.stringify(diagnostic)}`);
  if (!screenshot) return;
  const encoded = screenshot.toString("base64");
  const chunkSize = 6000;
  const total = Math.ceil(encoded.length / chunkSize);
  for (let index = 0; index < total; index += 1) {
    console.log(`TAP_PAGE_SCREENSHOT ${diagnostic.state} ${index + 1}/${total} ${encoded.slice(index * chunkSize, (index + 1) * chunkSize)}`);
  }
}

async function visiblePageText(page, secret) {
  try { return safeText(await page.locator("body").innerText(), 1200, [secret]); } catch { return ""; }
}

function captureController({ enabled, temporaryAccessPass, reportDiagnostic }) {
  const capturedPageStates = new Set();
  return async (page, requestedState) => {
    if (!enabled || !page) return;
    const state = /^[a-z0-9-]+$/.test(requestedState || "") ? requestedState : "unrecognized";
    if (capturedPageStates.has(state)) return;
    capturedPageStates.add(state);
    try {
      const diagnostic = {
        state,
        title: safeText(await page.title(), 200, [temporaryAccessPass]),
        url: diagnosticUrl(page.url()),
        headings: await page.locator("h1:visible, h2:visible, h3:visible, h4:visible, h5:visible, h6:visible").allInnerTexts().then(values => values.map(value => safeText(value, 200, [temporaryAccessPass])).filter(Boolean)),
        buttons: await page.locator('button:visible, input[type="submit"]:visible, input[type="button"]:visible').evaluateAll(elements => elements.map(element => (element.getAttribute("aria-label") || element.value || element.innerText || "").trim()).filter(Boolean)),
        inputs: await page.locator("input:visible").evaluateAll(elements => elements.map(element => ({ name: element.getAttribute("name") || "", type: element.getAttribute("type") || "text" })))
      };
      const screenshot = await page.screenshot({ type: "jpeg", quality: 75, fullPage: false, mask: [page.locator("input:visible, textarea:visible")], maskColor: "#000000" });
      await reportDiagnostic({ diagnostic, screenshot });
    } catch (error) {
      await reportDiagnostic({ diagnostic: { state, title: "unavailable", url: diagnosticUrl(page.url()), headings: [], buttons: [], inputs: [], captureError: safeText(error?.message, 300, [temporaryAccessPass]) } });
    }
  };
}

function sameCallbackEndpoint(value, redirectUri) {
  try {
    const candidate = value instanceof URL ? value : new URL(value);
    const expected = new URL(redirectUri);
    return candidate.origin === expected.origin && candidate.pathname === expected.pathname;
  } catch { return false; }
}

export function outcomeFromUrl(value, redirectUri, expectedState) {
  try {
    const current = new URL(value);
    if (!sameCallbackEndpoint(current, redirectUri)) return null;
    const oauthError = current.searchParams.get("error");
    if (!oauthError && !current.searchParams.has("code")) return null;
    if (current.searchParams.get("state") !== expectedState) return { kind: "error", message: "The OAuth state value did not match." };
    if (oauthError) return { kind: "error", message: `${oauthError}: ${current.searchParams.get("error_description") || "OAuth authorization failed."}` };
    return { kind: "code", code: current.searchParams.get("code") };
  } catch { return null; }
}

export async function createCallbackObserver(context, redirectUri, expectedState, { fulfillCallback = true, checkpoint = () => {} } = {}) {
  let outcome = null;
  const capture = value => {
    if (outcome) return outcome;
    const candidate = outcomeFromUrl(value, redirectUri, expectedState);
    if (candidate) outcome = candidate;
    return candidate;
  };
  context.on("request", request => capture(request.url()));
  context.on("framenavigated", frame => capture(frame.url()));

  if (fulfillCallback) {
    try {
      await context.route(url => sameCallbackEndpoint(url, redirectUri), async route => {
        capture(route.request().url());
        try {
          await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>After Party sign-in captured</title><p>The sign-in callback was captured. You can close this window.</p>" });
        } catch {
          checkpoint("callback-fulfillment", "failed-after-capture");
          await route.abort().catch(() => {});
        }
      });
    } catch {
      checkpoint("callback-fulfillment", "unavailable");
    }
  }
  return Object.freeze({ getOutcome: () => outcome });
}

async function submitTap(page, upn, temporaryAccessPass, emitPageCapture, checkpoint, signal) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const text = await visiblePageText(page, temporaryAccessPass);
    if (isRegistrationInterruption(page.url(), text)) return { kind: "registration", message: text };
    if (isAccountSelectionPage(text)) {
      await emitPageCapture(page, "account-selection");
      const selection = await clickAccountSelection(page, upn);
      checkpoint("account-selection", selection);
      if (selection !== "unhandled") { await wait(500); continue; }
    }

    const username = page.locator('input[name="loginfmt"]:visible');
    const tapInput = page.locator(TAP_INPUT_SELECTOR).first();
    const stage = credentialEntryStage({
      usernameVisible: await username.isVisible().catch(() => false),
      tapVisible: await tapInput.isVisible().catch(() => false)
    });
    if (stage === "username") {
      await emitPageCapture(page, "username");
      await username.fill(upn);
      await page.locator("#idSIButton9").click();
      checkpoint("username", "submitted");
      await wait(500);
      continue;
    }
    if (stage === "tap") {
      await emitPageCapture(page, "temporary-access-pass");
      await tapInput.fill(temporaryAccessPass);
      await clickTapSignIn(page);
      checkpoint("temporary-access-pass", "submitted");
      return { kind: "submitted" };
    }
    await wait(250);
  }
  throw new Error("Microsoft did not display a username, account-selection, or Temporary Access Pass screen.");
}

async function waitForOutcome(page, getCallbackOutcome, redirectUri, expectedState, timeoutMs, temporaryAccessPass, emitPageCapture, checkpoint, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const callbackOutcome = getCallbackOutcome() || outcomeFromUrl(page.url(), redirectUri, expectedState);
    if (callbackOutcome) return callbackOutcome;
    const text = await visiblePageText(page, temporaryAccessPass);
    if (isRegistrationInterruption(page.url(), text)) return { kind: "registration", message: text };
    if (/stay signed in/i.test(text)) {
      await emitPageCapture(page, "stay-signed-in");
      const no = page.locator('#idBtn_Back, button:has-text("No")').first();
      if (await no.isVisible().catch(() => false)) {
        await no.click();
        checkpoint("stay-signed-in", "declined");
        await wait(500);
        continue;
      }
    }
    if (isPermissionsRequestedPage(text)) {
      await emitPageCapture(page, "permissions-requested");
      if (await clickConsentAccept(page)) {
        checkpoint("consent", "accepted");
        await wait(500);
        continue;
      }
    }
    await wait(500);
  }
  return { kind: "timeout", message: await visiblePageText(page, temporaryAccessPass) };
}

export function buildAuthorizeUrl({ tenantId, clientId, upn, redirectUri = DEFAULT_REDIRECT_URI, state, challenge }) {
  const authorizeUrl = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_mode", "query");
  authorizeUrl.searchParams.set("scope", DEFAULT_SCOPE);
  authorizeUrl.searchParams.set("login_hint", upn);
  authorizeUrl.searchParams.set("prompt", "login");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  return authorizeUrl;
}

export async function runTapSignIn(configuration, dependencies = {}) {
  const {
    tenantId,
    tenantDomain,
    clientId,
    userAlias,
    temporaryAccessPass,
    capturePageOnFailure = false,
    headless = true,
    maxPropagationAttempts = 3,
    redirectUri = DEFAULT_REDIRECT_URI
  } = configuration || {};
  if (!tenantId || !tenantDomain || !clientId || !userAlias || !temporaryAccessPass) throw new Error("The browser worker configuration is incomplete.");
  if (!Number.isInteger(maxPropagationAttempts) || maxPropagationAttempts < 1 || maxPropagationAttempts > 3) throw new Error("The browser worker retry configuration is invalid.");

  const upn = tenantUserPrincipalName(userAlias, tenantDomain);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const checkpoint = dependencies.checkpoint || (() => {});
  const reportDiagnostic = dependencies.reportDiagnostic || defaultDiagnosticReporter;
  const signal = dependencies.signal;
  const emitPageCapture = captureController({ enabled: capturePageOnFailure, temporaryAccessPass, reportDiagnostic });
  const playwright = dependencies.chromium ? dependencies : await import("playwright");
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless });
    const pkce = createPkce();
    const state = base64Url(randomBytes(32));
    const authorizeUrl = buildAuthorizeUrl({ tenantId, clientId, upn, redirectUri, state, challenge: pkce.challenge });
    let outcome;

    for (let propagationAttempt = 1; propagationAttempt <= maxPropagationAttempts; propagationAttempt += 1) {
      signal?.throwIfAborted();
      const context = await browser.newContext();
      checkpoint("browser-context", "fresh");
      const callbackObserver = await createCallbackObserver(context, redirectUri, state, { checkpoint });
      const page = await context.newPage();
      try {
        await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
        const submission = await submitTap(page, upn, temporaryAccessPass, emitPageCapture, checkpoint, signal);
        if (submission.kind === "registration") outcome = submission;
        else outcome = await waitForOutcome(page, callbackObserver.getOutcome, redirectUri, state, 30000, temporaryAccessPass, emitPageCapture, checkpoint, signal);
        if (["code", "registration"].includes(outcome.kind)) break;
        const retryable = /temporary access pass|try again|incorrect|invalid|expired|not recognized/i.test(outcome.message || "");
        if (!retryable || propagationAttempt === maxPropagationAttempts) {
          await emitPageCapture(page, "unrecognized");
          break;
        }
      } catch (error) {
        await emitPageCapture(page, "unrecognized");
        throw error;
      } finally {
        await context.close();
      }
      await wait(propagationAttempt * 5000);
    }

    if (outcome?.kind === "registration") {
      return { result: "registration_interrupted", upn, stage: "security_information", message: "Microsoft required security-information or MFA registration. No authentication method was registered." };
    }
    if (outcome?.kind !== "code" || !outcome.code) throw new Error(outcome?.message || "The TAP sign-in did not return an authorization code.");
    checkpoint("callback", "captured");

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      code: outcome.code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: pkce.verifier,
      scope: DEFAULT_SCOPE
    });
    const tokenResponse = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult.access_token) throw new Error(`${tokenResult.error || "token_exchange_failed"}: ${tokenResult.error_description || `HTTP ${tokenResponse.status}`}`);
    const delegatedAccessToken = tokenResult.access_token;
    if (String(decodeJwtClaim(delegatedAccessToken, "tid") || "").toLowerCase() !== tenantId.toLowerCase()) throw new Error("The delegated token tenant did not match the expected tenant.");
    checkpoint("token", "tenant-confirmed");

    const meResponse = await fetchImpl("https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName", {
      headers: { Authorization: `Bearer ${delegatedAccessToken}` }
    });
    const me = await meResponse.json();
    if (!meResponse.ok) throw new Error(`${me.error?.code || "graph_me_failed"}: ${me.error?.message || `HTTP ${meResponse.status}`}`);
    if (me.displayName !== "Lisa Simpson" || String(me.userPrincipalName || "").toLowerCase() !== upn.toLowerCase()) {
      throw new Error("Microsoft Graph /me did not confirm Lisa Simpson in the expected tenant.");
    }
    checkpoint("graph-me", "confirmed");
    return { result: "confirmed", upn, displayName: me.displayName, tenantId, stage: "graph_me" };
  } finally {
    await browser?.close();
  }
}

export function configurationFromEnvironment(environment = process.env) {
  return {
    tenantId: environment.TENANT_ID,
    tenantDomain: environment.TENANT_DOMAIN,
    clientId: environment.CLIENT_ID,
    userAlias: environment.USER_ALIAS,
    temporaryAccessPass: environment.TEMPORARY_ACCESS_PASS,
    capturePageOnFailure: environment.CAPTURE_PAGE_ON_FAILURE === "1"
  };
}

async function runFromEnvironment() {
  const configuration = configurationFromEnvironment();
  try {
    const result = await runTapSignIn(configuration);
    defaultResultReporter(result);
    if (result.result === "registration_interrupted") process.exitCode = 2;
  } catch (error) {
    const upn = configuration.userAlias && configuration.tenantDomain
      ? tenantUserPrincipalName(configuration.userAlias, configuration.tenantDomain)
      : undefined;
    defaultResultReporter({ result: "failed", upn, stage: "sign_in", message: safeText(error?.message, 700, [configuration.temporaryAccessPass]) });
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (process.env.AFTER_PARTY_WORKER_TEST !== "1" && isMain) await runFromEnvironment();
