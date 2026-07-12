import { chromium } from "playwright";
import { randomUUID } from "node:crypto";

const tenantId = process.env.TENANT_ID;
const baselineUrl = process.env.BASELINE_URL;

function fail(message, diagnostic = {}) {
  console.log(`BROWSER_SIGN_IN_RESULT ${JSON.stringify({ upn: diagnostic.upn || "unknown", timestampUtc: new Date().toISOString(), result: "not_confirmed", diagnostic: { message, ...diagnostic } })}`);
  process.exitCode = 1;
}

if (!tenantId || !baselineUrl) {
  fail("Worker configuration is incomplete.");
} else {
  let browser;
  let page;
  try {
    const response = await fetch(baselineUrl);
    if (!response.ok) throw new Error(`Tenant baseline returned ${response.status}.`);
    const baseline = await response.json();
    const lab = baseline.failedSignInLab;
    const upn = lab?.userPrincipalName;
    const clientId = lab?.clientId;
    if (!upn || !clientId || !(baseline.users || []).some(user => user.userPrincipalName === upn)) throw new Error("Tenant baseline does not contain a valid browser failed sign-in target.");

    const invalidPassword = `AfterParty-Invalid-${randomUUID().replaceAll("-", "")}`;
    const authorizeUrl = new URL(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`);
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost");
    authorizeUrl.searchParams.set("response_mode", "query");
    authorizeUrl.searchParams.set("scope", "openid profile");

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(authorizeUrl.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.locator('input[name="loginfmt"]').fill(upn);
    await page.locator('#idSIButton9').click();
    await page.locator('input[name="passwd"]').waitFor({ state: "visible", timeout: 30000 });
    await page.locator('input[name="passwd"]').fill(invalidPassword);
    await page.locator('#idSIButton9').click();
    await page.waitForFunction(() => /account or password is incorrect|password is incorrect|incorrect password/i.test(document.body.innerText), null, { timeout: 30000 });

    const errorText = (await page.locator("body").innerText()).match(/.{0,80}(account or password is incorrect|password is incorrect|incorrect password).{0,80}/i)?.[0] || "Microsoft displayed an invalid-credentials message.";
    console.log(`BROWSER_SIGN_IN_RESULT ${JSON.stringify({ upn, timestampUtc: new Date().toISOString(), result: "credentials_rejected", diagnostic: { finalUrl: new URL(page.url()).origin, message: errorText } })}`);
  } catch (error) {
    fail(error.message, { finalUrl: page?.url ? page.url() : undefined });
  } finally {
    await browser?.close();
  }
}
