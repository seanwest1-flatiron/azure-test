import { createHash, randomBytes } from "node:crypto";

const RESULT_PREFIX = "TAP_SIGN_IN_RESULT ";
const tenantId = process.env.TENANT_ID;
const tenantDomain = process.env.TENANT_DOMAIN;
const clientId = process.env.CLIENT_ID;
const userAlias = process.env.USER_ALIAS;
const temporaryAccessPass = process.env.TEMPORARY_ACCESS_PASS;

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

export function safeText(value, maximumLength = 500) {
  let text = String(value || "")
    .replace(/([?&#](?:code|access_token|id_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ").trim();
  if (temporaryAccessPass) text = text.split(temporaryAccessPass).join("[redacted]");
  return text.length > maximumLength ? `${text.slice(0, maximumLength)}…` : text;
}

export function isRegistrationInterruption(url, pageText) {
  return /(?:mysignins\.microsoft\.com\/security-info|aka\.ms\/mfasetup)/i.test(url || "") ||
    /(?:more information required|keep your account secure|set up your account|security info|microsoft authenticator|add (?:a )?sign-in method)/i.test(pageText || "");
}

export function decodeJwtClaim(token, claim) {
  const segment = String(token || "").split(".")[1];
  if (!segment) throw new Error("The delegated access token was not a valid JWT.");
  const payload = JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  return payload[claim];
}

function report(result, details = {}) {
  console.log(`${RESULT_PREFIX}${JSON.stringify({ result, ...details, timestampUtc: new Date().toISOString() })}`);
}

async function visiblePageText(page) {
  try { return safeText(await page.locator("body").innerText(), 1200); } catch { return ""; }
}

async function waitForOutcome(page, expectedState, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const currentUrl = page.url();
    const text = await visiblePageText(page);
    if (isRegistrationInterruption(currentUrl, text)) return { kind: "registration", message: text };
    try {
      const current = new URL(currentUrl);
      if (current.origin === "http://localhost" && current.searchParams.has("code")) {
        if (current.searchParams.get("state") !== expectedState) return { kind: "error", message: "The OAuth state value did not match." };
        return { kind: "code", code: current.searchParams.get("code") };
      }
      const oauthError = current.searchParams.get("error");
      if (oauthError) return { kind: "error", message: `${oauthError}: ${current.searchParams.get("error_description") || "OAuth authorization failed."}` };
    } catch { /* The page can briefly expose a non-URL during navigation. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  return { kind: "timeout", message: await visiblePageText(page) };
}

async function submitTap(page, upn) {
  const username = page.locator('input[name="loginfmt"]');
  await username.waitFor({ state: "visible", timeout: 30000 });
  await username.fill(upn);
  await page.locator("#idSIButton9").click();

  const tapInput = page.locator('input[name="passwd"]');
  await tapInput.waitFor({ state: "visible", timeout: 30000 });
  await tapInput.fill(temporaryAccessPass);
  await page.locator("#idSIButton9").click();
}

async function advancePostAuthentication(page) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const text = await visiblePageText(page);
    if (isRegistrationInterruption(page.url(), text)) return;
    if (/stay signed in/i.test(text)) {
      const no = page.locator('#idBtn_Back, button:has-text("No")').first();
      if (await no.isVisible().catch(() => false)) { await no.click(); await new Promise(resolve => setTimeout(resolve, 500)); continue; }
    }
    if (/permissions requested|accept the permissions request/i.test(text)) {
      const accept = page.locator('#idSIButton9, button:has-text("Accept")').first();
      if (await accept.isVisible().catch(() => false)) { await accept.click(); await new Promise(resolve => setTimeout(resolve, 500)); continue; }
    }
    return;
  }
}

async function run() {
  let browser;
  if (!tenantId || !tenantDomain || !clientId || !userAlias || !temporaryAccessPass) {
    report("failed", { stage: "configuration", message: "The browser worker configuration is incomplete." });
    process.exitCode = 1;
    return;
  }

  const upn = tenantUserPrincipalName(userAlias, tenantDomain);
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const pkce = createPkce();
    const state = base64Url(randomBytes(32));
    const authorizeUrl = new URL(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost");
    authorizeUrl.searchParams.set("response_mode", "query");
    authorizeUrl.searchParams.set("scope", "openid profile https://graph.microsoft.com/User.Read");
    authorizeUrl.searchParams.set("login_hint", upn);
    authorizeUrl.searchParams.set("prompt", "login");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", pkce.challenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    let outcome;
    for (let propagationAttempt = 1; propagationAttempt <= 3; propagationAttempt += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
        await submitTap(page, upn);
        await new Promise(resolve => setTimeout(resolve, 1000));
        await advancePostAuthentication(page);
        outcome = await waitForOutcome(page, state, 30000);
        if (["code", "registration"].includes(outcome.kind)) break;
        const retryable = /temporary access pass|try again|incorrect|invalid|expired|not recognized/i.test(outcome.message || "");
        if (!retryable || propagationAttempt === 3) break;
      } finally {
        await context.close();
      }
      await new Promise(resolve => setTimeout(resolve, propagationAttempt * 5000));
    }

    if (outcome?.kind === "registration") {
      report("registration_interrupted", { upn, stage: "security_information", message: "Microsoft required security-information or MFA registration. No authentication method was registered." });
      process.exitCode = 2;
      return;
    }
    if (outcome?.kind !== "code" || !outcome.code) throw new Error(outcome?.message || "The TAP sign-in did not return an authorization code.");

    const tokenBody = new URLSearchParams({
      client_id: clientId,
      code: outcome.code,
      redirect_uri: "http://localhost",
      grant_type: "authorization_code",
      code_verifier: pkce.verifier,
      scope: "openid profile https://graph.microsoft.com/User.Read"
    });
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody
    });
    const tokenResult = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenResult.access_token) throw new Error(`${tokenResult.error || "token_exchange_failed"}: ${tokenResult.error_description || `HTTP ${tokenResponse.status}`}`);
    const delegatedAccessToken = tokenResult.access_token;
    if (String(decodeJwtClaim(delegatedAccessToken, "tid") || "").toLowerCase() !== tenantId.toLowerCase()) throw new Error("The delegated token tenant did not match the expected tenant.");

    const meResponse = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,userPrincipalName", {
      headers: { Authorization: `Bearer ${delegatedAccessToken}` }
    });
    const me = await meResponse.json();
    if (!meResponse.ok) throw new Error(`${me.error?.code || "graph_me_failed"}: ${me.error?.message || `HTTP ${meResponse.status}`}`);
    if (me.displayName !== "Lisa Simpson" || String(me.userPrincipalName || "").toLowerCase() !== upn.toLowerCase()) {
      throw new Error("Microsoft Graph /me did not confirm Lisa Simpson in the expected tenant.");
    }
    report("confirmed", { upn, displayName: me.displayName, tenantId, stage: "graph_me" });
  } catch (error) {
    report("failed", { upn, stage: "sign_in", message: safeText(error?.message, 700) });
    process.exitCode = 1;
  } finally {
    await browser?.close();
  }
}

if (process.env.AFTER_PARTY_WORKER_TEST !== "1") await run();
