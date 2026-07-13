import { randomUUID } from "node:crypto";

const tenantId = process.env.TENANT_ID;
const baselineUrl = process.env.BASELINE_URL;
const MAX_PAGE_TEXT_LENGTH = 1200;
const MAX_DIAGNOSTIC_ITEMS = 10;

export function boundedText(value, maxLength = MAX_PAGE_TEXT_LENGTH) {
  const text = String(value || "")
    .replace(/([?&#](?:code|access_token|id_token|refresh_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

export function sanitizedUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

export async function collectPageDiagnostic(page, progress) {
  const diagnostic = { ...progress };
  if (!page) return diagnostic;

  diagnostic.finalUrl = sanitizedUrl(page.url());
  try { diagnostic.pageTitle = boundedText(await page.title(), 200); } catch { /* Preserve the primary worker error. */ }
  try { diagnostic.visiblePageText = boundedText(await page.locator("body").innerText()); } catch { /* Preserve the primary worker error. */ }
  try {
    diagnostic.visibleInputs = await page.locator("input:visible").evaluateAll(elements => elements.slice(0, 10).map(element => ({
      type: element.getAttribute("type") || "text",
      name: element.getAttribute("name") || undefined,
      label: element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.id || undefined
    })));
  } catch { /* Preserve the primary worker error. */ }
  try {
    diagnostic.visibleButtons = await page.locator('button:visible, input[type="submit"]:visible, input[type="button"]:visible').evaluateAll(elements => elements.slice(0, 10).map(element => ({
      type: element.getAttribute("type") || "button",
      label: (element.getAttribute("aria-label") || element.value || element.innerText || "").trim()
    })));
  } catch { /* Preserve the primary worker error. */ }

  const pageText = diagnostic.visiblePageText || "";
  diagnostic.microsoftErrorCode = pageText.match(/\bAADSTS\d{5,}\b/i)?.[0];
  diagnostic.rejectionText = pageText.match(/.{0,100}(account or password is incorrect|password is incorrect|incorrect password).{0,100}/i)?.[0];
  return diagnostic;
}

function fail(message, diagnostic = {}) {
  console.log(`BROWSER_SIGN_IN_RESULT ${JSON.stringify({ upn: diagnostic.upn || "unknown", timestampUtc: new Date().toISOString(), result: "not_confirmed", diagnostic: { message: boundedText(message, 500), ...diagnostic } })}`);
  process.exitCode = 1;
}

async function getOutboundIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json");
    const result = await response.json();
    return /^[0-9a-f:.]+$/i.test(result.ip || "") ? result.ip : "unavailable";
  } catch { return "unavailable"; }
}

async function runThreeAttempts({ chromium, clientId, upn, invalidPassword, authorizeUrl }) {
  const browser = await chromium.launch({ headless: true });
  const workerOutboundIp = await getOutboundIp();
  const attempts = [];
  try {
    for (let number = 1; number <= 3; number += 1) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const progress = { lastCompletedStage: "worker_started", usernameSubmissionAttempted: false, passwordSubmissionAttempted: false, consoleMessages: [], requestFailures: [] };
      try {
        await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
        progress.lastCompletedStage = "authorize_page_loaded";
        await page.locator('input[name="loginfmt"]').fill(upn);
        progress.lastCompletedStage = "username_filled";
        progress.usernameSubmissionAttempted = true;
        await page.locator('#idSIButton9').click();
        progress.lastCompletedStage = "username_submitted";
        await page.locator('input[name="passwd"]').waitFor({ state: "visible", timeout: 30000 });
        progress.lastCompletedStage = "password_visible";
        await page.locator('input[name="passwd"]').fill(invalidPassword);
        progress.lastCompletedStage = "password_filled";
        const postResponse = page.waitForResponse(response => response.request().method() === "POST" && sanitizedUrl(response.url())?.startsWith("https://login.microsoftonline.com/"), { timeout: 10000 }).then(() => true).catch(() => false);
        progress.passwordSubmissionAttempted = true;
        await page.locator('#idSIButton9').click();
        progress.lastCompletedStage = "password_submitted";
        const submissionProcessed = await postResponse;
        const diagnostic = await collectPageDiagnostic(page, progress);
        const pageText = diagnostic.visiblePageText || "";
        if (/AADSTS50053/i.test(pageText)) throw new Error("AADSTS50053 detected; stopped before another sign-in attempt.");
        if (/captcha|unusual activity|verify your identity|robot|challenge/i.test(`${diagnostic.pageTitle || ""} ${pageText}`)) throw new Error("A bot or challenge screen was detected; stopped before another sign-in attempt.");
        const final = new URL(page.url());
        if (final.origin === "http://localhost" || final.searchParams.has("code")) throw new Error("Unexpected successful authentication was detected; stopped before another sign-in attempt.");
        if (!submissionProcessed) throw new Error("The password submission could not be confirmed; stopped before another sign-in attempt.");
        attempts.push({ number, timestampUtc: new Date().toISOString(), stage: progress.lastCompletedStage, submissionProcessed, workerOutboundIp });
      } finally { await context.close(); }
    }
    console.log(`BROWSER_SIGN_IN_RESULT ${JSON.stringify({ upn, timestampUtc: new Date().toISOString(), result: "attempts_submitted", diagnostic: { workerOutboundIp, attempts } })}`);
  } finally { await browser.close(); }
}

async function run() {
  if (!tenantId || !baselineUrl) {
    fail("Worker configuration is incomplete.");
    return;
  }
  let browser;
  let page;
  let upn;
  const progress = {
    lastCompletedStage: "worker_started",
    usernameSubmissionAttempted: false,
    passwordSubmissionAttempted: false,
    consoleMessages: [],
    requestFailures: []
  };
  try {
    const response = await fetch(baselineUrl);
    if (!response.ok) throw new Error(`Tenant baseline returned ${response.status}.`);
    const baseline = await response.json();
    const lab = baseline.failedSignInLab;
    upn = lab?.userPrincipalName;
    const clientId = lab?.clientId;
    if (!upn || !clientId || !(baseline.users || []).some(user => user.userPrincipalName === upn)) throw new Error("Tenant baseline does not contain a valid browser failed sign-in target.");
    progress.lastCompletedStage = "baseline_loaded";

    const invalidPassword = `AfterParty-Invalid-${randomUUID().replaceAll("-", "")}`;
    const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost");
    authorizeUrl.searchParams.set("response_mode", "query");
    authorizeUrl.searchParams.set("scope", "openid profile");

    const { chromium } = await import("playwright");
    if (process.env.ATTEMPT_COUNT === "3") {
      await runThreeAttempts({ chromium, clientId, upn, invalidPassword, authorizeUrl });
      return;
    }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.on("console", message => {
      if (["warning", "error"].includes(message.type()) && progress.consoleMessages.length < MAX_DIAGNOSTIC_ITEMS) {
        progress.consoleMessages.push({ type: message.type(), text: boundedText(message.text(), 300) });
      }
    });
    page.on("requestfailed", request => {
      if (progress.requestFailures.length < MAX_DIAGNOSTIC_ITEMS) {
        progress.requestFailures.push({ url: sanitizedUrl(request.url()), error: boundedText(request.failure()?.errorText, 300) });
      }
    });
    progress.lastCompletedStage = "browser_launched";
    await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    progress.lastCompletedStage = "authorize_page_loaded";
    await page.locator('input[name="loginfmt"]').fill(upn);
    progress.lastCompletedStage = "username_filled";
    progress.usernameSubmissionAttempted = true;
    await page.locator('#idSIButton9').click();
    progress.lastCompletedStage = "username_submitted";
    await page.locator('input[name="passwd"]').waitFor({ state: "visible", timeout: 30000 });
    progress.lastCompletedStage = "password_visible";
    await page.locator('input[name="passwd"]').fill(invalidPassword);
    progress.lastCompletedStage = "password_filled";
    progress.passwordSubmissionAttempted = true;
    await page.locator('#idSIButton9').click();
    progress.lastCompletedStage = "password_submitted";
    await page.waitForFunction(() => /account or password is incorrect|password is incorrect|incorrect password/i.test(document.body.innerText), null, { timeout: 30000 });
    progress.lastCompletedStage = "credential_rejection_confirmed";

    const errorText = (await page.locator("body").innerText()).match(/.{0,80}(account or password is incorrect|password is incorrect|incorrect password).{0,80}/i)?.[0] || "Microsoft displayed an invalid-credentials message.";
    console.log(`BROWSER_SIGN_IN_RESULT ${JSON.stringify({ upn, timestampUtc: new Date().toISOString(), result: "credentials_rejected", diagnostic: { finalUrl: sanitizedUrl(page.url()), message: errorText } })}`);
  } catch (error) {
    fail(error.message, { upn, ...await collectPageDiagnostic(page, progress) });
  } finally {
    await browser?.close();
  }
}

if (process.env.AFTER_PARTY_WORKER_TEST !== "1") {
  await run();
}
