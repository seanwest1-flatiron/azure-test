"use strict";

(() => {
  const config = window.AFTER_PARTY_CONFIG;
  const ARM = "https://management.azure.com";
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
  const ARM_SCOPE = "https://management.azure.com/user_impersonation";
  const GRAPH_SCOPES = ["Application.Read.All", "AppRoleAssignment.ReadWrite.All"];
  const RUNNER_STORAGE_KEY = "afterParty.runner.v1";
  const apiVersions = Object.freeze({ resources: "2021-04-01", deployments: "2022-09-01", automation: "2024-10-23" });
  const el = Object.fromEntries(["configuration-warning", "status", "sign-in", "sign-out", "account", "subscription", "resource-group", "location", "automation-name", "install", "run"].map(id => [id, document.getElementById(id)]));
  let msalClient;
  let account;
  let busy = false;

  function setStatus(message, kind = "") {
    el.status.textContent = message;
    el.status.className = `notice ${kind}`.trim();
  }

  function explainError(error) {
    const message = error?.error?.message || error?.message || String(error);
    return message.replace(/^Error:\s*/, "");
  }

  function setBusy(value) {
    busy = value;
    refreshControls();
  }

  function getRunner() {
    try { return JSON.parse(localStorage.getItem(RUNNER_STORAGE_KEY)); } catch { return null; }
  }

  function refreshControls() {
    const signedIn = Boolean(account);
    el["sign-in"].hidden = signedIn;
    el["sign-out"].hidden = !signedIn;
    el.subscription.disabled = busy || !signedIn;
    el["resource-group"].disabled = busy || !signedIn || !el.subscription.value;
    el.location.disabled = busy || !signedIn;
    el["automation-name"].disabled = busy || !signedIn;
    el.install.disabled = busy || !signedIn || !el.subscription.value || !el["resource-group"].value || !el.location.value.trim() || !el["automation-name"].value.trim();
    const runner = getRunner();
    el.run.disabled = busy || !signedIn || !runner || runner.tenantId !== account.tenantId;
  }

  async function token(scopes) {
    const request = { account, scopes };
    try {
      return (await msalClient.acquireTokenSilent(request)).accessToken;
    } catch (error) {
      if (error instanceof msal.InteractionRequiredAuthError) {
        return (await msalClient.acquireTokenPopup(request)).accessToken;
      }
      throw error;
    }
  }

  async function requestJson(url, options = {}, accessToken) {
    const response = await fetch(url, {
      ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers }
    });
    const text = await response.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = { message: text }; } }
    if (!response.ok) {
      const error = new Error(body?.error?.message || body?.message || `${response.status} ${response.statusText}`);
      error.status = response.status;
      error.error = body?.error;
      throw error;
    }
    return body;
  }

  async function arm(path, options = {}) {
    return requestJson(`${ARM}${path}`, options, await token([ARM_SCOPE]));
  }

  async function graph(path, options = {}) {
    return requestJson(`${GRAPH}${path}`, options, await token(GRAPH_SCOPES));
  }

  function fillSelect(select, items, placeholder, valueKey, labelKey) {
    select.replaceChildren(new Option(placeholder, ""), ...items.map(item => new Option(item[labelKey], item[valueKey])));
  }

  async function loadSubscriptions() {
    setStatus("Loading Azure subscriptions…");
    const result = await arm(`/subscriptions?api-version=${apiVersions.resources}`);
    const subscriptions = (result.value || []).filter(item => item.state === "Enabled");
    fillSelect(el.subscription, subscriptions, "Choose a subscription", "subscriptionId", "displayName");
    setStatus(subscriptions.length ? "Signed in. Choose where to install the runner." : "No enabled Azure subscriptions are available to this account.", subscriptions.length ? "success" : "error");
  }

  async function loadResourceGroups() {
    const subscriptionId = el.subscription.value;
    fillSelect(el["resource-group"], [], subscriptionId ? "Loading…" : "Choose a subscription", "name", "name");
    refreshControls();
    if (!subscriptionId) return;
    const result = await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups?api-version=${apiVersions.resources}`);
    fillSelect(el["resource-group"], result.value || [], "Choose a resource group", "name", "name");
    refreshControls();
  }

  async function waitForDeployment(path) {
    for (let attempt = 0; attempt < 150; attempt += 1) {
      const deployment = await arm(path);
      const state = deployment.properties?.provisioningState;
      setStatus(`Azure deployment: ${state || "running"}…`);
      if (state === "Succeeded") return deployment;
      if (["Failed", "Canceled"].includes(state)) throw new Error(deployment.properties?.error?.message || `Deployment ${state}.`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error("Timed out waiting for the Azure deployment.");
  }

  async function grantMailSend(principalId) {
    setStatus("Finding the Microsoft Graph Mail.Send application role…");
    const result = await graph(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APP_ID}'`)}&$select=id,appRoles`);
    const graphPrincipal = result.value?.[0];
    const mailSend = graphPrincipal?.appRoles?.find(role => role.value === "Mail.Send" && role.isEnabled && role.allowedMemberTypes?.includes("Application"));
    if (!graphPrincipal || !mailSend) throw new Error("Microsoft Graph Mail.Send application role was not found in this tenant.");
    setStatus("Granting Mail.Send to the Automation managed identity…");
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await graph(`/servicePrincipals/${graphPrincipal.id}/appRoleAssignedTo`, {
          method: "POST",
          body: JSON.stringify({ principalId, resourceId: graphPrincipal.id, appRoleId: mailSend.id })
        });
        return;
      } catch (error) {
        const message = explainError(error);
        if (error.status === 400 && /already exists/i.test(message)) return;
        const identityNotReady = [400, 404].includes(error.status) && /(principal|service principal|does not exist|not found)/i.test(message);
        if (!identityNotReady || attempt === 29) throw error;
        setStatus("Waiting for the new managed identity to appear in Microsoft Entra…");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async function installRunner() {
    setBusy(true);
    try {
      const subscriptionId = el.subscription.value;
      const resourceGroup = el["resource-group"].value;
      const automationAccountName = el["automation-name"].value.trim();
      if (!/^[a-zA-Z][a-zA-Z0-9-]{5,49}$/.test(automationAccountName)) throw new Error("Automation account name must start with a letter and contain 6–50 letters, numbers, or hyphens.");
      setStatus("Registering the Microsoft.Automation resource provider…");
      await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Automation/register?api-version=${apiVersions.resources}`, { method: "POST" });
      setStatus("Loading the runner template…");
      const template = await requestJson("azuredeploy.json", { cache: "no-store" });
      const deploymentName = `after-party-${Date.now()}`;
      const deploymentPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=${apiVersions.deployments}`;
      await arm(deploymentPath, {
        method: "PUT",
        body: JSON.stringify({ properties: { mode: "Incremental", template, parameters: {
          location: { value: el.location.value.trim() },
          automationAccountName: { value: automationAccountName },
          bootstrapUri: { value: `${config.repositoryRawBase}/runbooks/bootstrap.ps1` }
        } } })
      });
      const deployment = await waitForDeployment(deploymentPath);
      const principalId = deployment.properties.outputs?.managedIdentityPrincipalId?.value;
      if (!principalId) throw new Error("Deployment succeeded but did not return the managed identity principal ID.");
      await grantMailSend(principalId);
      localStorage.setItem(RUNNER_STORAGE_KEY, JSON.stringify({ tenantId: account.tenantId, subscriptionId, resourceGroup, automationAccountName, runbookName: config.runbookName }));
      setStatus("Runner installed and Mail.Send granted. The email lab is ready.", "success");
    } finally {
      setBusy(false);
    }
  }

  async function runLab() {
    const runner = getRunner();
    if (!runner || runner.tenantId !== account.tenantId) throw new Error("Install the runner in this tenant first.");
    setBusy(true);
    try {
      const jobId = crypto.randomUUID();
      const path = `/subscriptions/${encodeURIComponent(runner.subscriptionId)}/resourcegroups/${encodeURIComponent(runner.resourceGroup)}/providers/Microsoft.Automation/automationAccounts/${encodeURIComponent(runner.automationAccountName)}/jobs/${jobId}?api-version=${apiVersions.automation}`;
      setStatus("Starting the existing Automation runbook…");
      await arm(path, { method: "PUT", body: JSON.stringify({ properties: { runbook: { name: runner.runbookName }, parameters: { LabPath: "labs/send-email.ps1" } } }) });
      setStatus(`Lab job started. Azure job ID: ${jobId}`, "success");
    } finally {
      setBusy(false);
    }
  }

  async function signedIn(nextAccount) {
    account = nextAccount;
    msalClient.setActiveAccount(account);
    el.account.textContent = `${account.name || account.username} (${account.tenantId})`;
    if (!el["automation-name"].value) el["automation-name"].value = `after-party-${account.tenantId.slice(0, 8)}-${Math.random().toString(36).slice(2, 7)}`;
    refreshControls();
    await loadSubscriptions();
  }

  async function initialize() {
    if (!config?.clientId) {
      el["configuration-warning"].hidden = false;
      el["configuration-warning"].textContent = "Set the Entra SPA application client ID in config.js before using this site.";
      setStatus("Configuration is incomplete.", "error");
      el["sign-in"].disabled = true;
      return;
    }
    if (!window.msal) throw new Error("msal-browser.min.js is missing or did not load.");
    msalClient = new msal.PublicClientApplication({ auth: { clientId: config.clientId, authority: config.authority, redirectUri: config.redirectUri }, cache: { cacheLocation: "sessionStorage" } });
    if (typeof msalClient.initialize === "function") await msalClient.initialize();
    const redirectResult = await msalClient.handleRedirectPromise();
    const cachedAccount = redirectResult?.account || msalClient.getAllAccounts()[0];
    if (cachedAccount) await signedIn(cachedAccount); else setStatus("Ready to sign in.");
  }

  el["sign-in"].addEventListener("click", async () => {
    try { const result = await msalClient.loginPopup({ scopes: ["openid", "profile"] }); await signedIn(result.account); } catch (error) { setStatus(explainError(error), "error"); }
  });
  el["sign-out"].addEventListener("click", () => msalClient.logoutPopup({ account }));
  el.subscription.addEventListener("change", () => loadResourceGroups().catch(error => setStatus(explainError(error), "error")));
  el["resource-group"].addEventListener("change", refreshControls);
  el.location.addEventListener("input", refreshControls);
  el["automation-name"].addEventListener("input", refreshControls);
  el.install.addEventListener("click", () => installRunner().catch(error => setStatus(explainError(error), "error")));
  el.run.addEventListener("click", () => runLab().catch(error => setStatus(explainError(error), "error")));
  initialize().catch(error => setStatus(explainError(error), "error"));
})();
