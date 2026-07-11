"use strict";

(() => {
  const config = window.AFTER_PARTY_CONFIG;
  const ARM = "https://management.azure.com";
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
  const APPLICATION_ROLES = Object.freeze(["Mail.Send", "Files.ReadWrite.All"]);
  const ARM_SCOPE = "https://management.azure.com/user_impersonation";
  const GRAPH_SCOPES = ["Application.Read.All", "AppRoleAssignment.ReadWrite.All"];
  const RUNNER_STORAGE_KEY = "afterParty.runner.v1";
  const PENDING_OPERATION_KEY = "afterParty.pendingOperation.v1";
  const apiVersions = Object.freeze({ resources: "2021-04-01", deployments: "2022-09-01", automation: "2024-10-23" });
  const el = Object.fromEntries(["configuration-warning", "status", "sign-in", "sign-out", "account", "authorization", "authorize-azure", "subscription", "resource-group", "location", "automation-name", "install", "run", "run-file-share", "run-email-triage", "run-customer-payment-export"].map(id => [id, document.getElementById(id)]));
  let msalClient;
  let account;
  let busy = false;
  const authorization = { arm: false, graph: false };
  const redirecting = Symbol("redirecting");

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

  function setAuthorizationSummary() {
    if (!account) {
      el.authorization.textContent = "Azure and Microsoft Graph access has not been authorized for an operation yet.";
      return;
    }
    const arm = authorization.arm ? "authorized" : "not yet authorized";
    const graph = authorization.graph ? "authorized" : "not yet authorized";
    el.authorization.textContent = `Signed in. Azure Resource Manager is ${arm}; Microsoft Graph admin access is ${graph}.`;
  }

  function formSnapshot() {
    return {
      subscriptionId: el.subscription.value,
      resourceGroup: el["resource-group"].value,
      location: el.location.value,
      automationAccountName: el["automation-name"].value
    };
  }

  function savePendingOperation(operation) {
    sessionStorage.setItem(PENDING_OPERATION_KEY, JSON.stringify({ operation, form: formSnapshot() }));
  }

  function takePendingOperation() {
    try {
      const pending = JSON.parse(sessionStorage.getItem(PENDING_OPERATION_KEY));
      sessionStorage.removeItem(PENDING_OPERATION_KEY);
      return pending;
    } catch {
      sessionStorage.removeItem(PENDING_OPERATION_KEY);
      return null;
    }
  }

  function restoreForm(snapshot = {}) {
    el.location.value = snapshot.location || el.location.value;
    el["automation-name"].value = snapshot.automationAccountName || el["automation-name"].value;
  }

  function noteAuthorized(scopes) {
    if (scopes.includes(ARM_SCOPE)) authorization.arm = true;
    if (scopes.some(scope => GRAPH_SCOPES.includes(scope))) authorization.graph = true;
    setAuthorizationSummary();
  }

  function getRunner() {
    try { return JSON.parse(localStorage.getItem(RUNNER_STORAGE_KEY)); } catch { return null; }
  }

  function refreshControls() {
    const signedIn = Boolean(account);
    el["sign-in"].hidden = signedIn;
    el["sign-out"].hidden = !signedIn;
    el["authorize-azure"].disabled = busy || !signedIn;
    el.subscription.disabled = busy || !signedIn;
    el["resource-group"].disabled = busy || !signedIn || !el.subscription.value;
    el.location.disabled = busy || !signedIn;
    el["automation-name"].disabled = busy || !signedIn;
    el.install.disabled = busy || !signedIn || !el.subscription.value || !el["resource-group"].value || !el.location.value.trim() || !el["automation-name"].value.trim();
    const runner = getRunner();
    el.run.disabled = busy || !signedIn || !runner || runner.tenantId !== account.tenantId;
    el["run-file-share"].disabled = busy || !signedIn || !runner || runner.tenantId !== account.tenantId;
    el["run-email-triage"].disabled = busy || !signedIn || !runner || runner.tenantId !== account.tenantId;
    el["run-customer-payment-export"].disabled = busy || !signedIn || !runner || runner.tenantId !== account.tenantId;
  }

  async function token(scopes, operation) {
    const request = { account, scopes };
    try {
      const result = await msalClient.acquireTokenSilent(request);
      noteAuthorized(scopes);
      return result.accessToken;
    } catch (error) {
      if (error instanceof msal.InteractionRequiredAuthError) {
        if (!operation) throw new Error("This operation needs authorization. Select the action again to continue.");
        savePendingOperation(operation);
        setStatus("You are signed in, but Microsoft needs to authorize this operation. Redirecting to Microsoft…");
        await msalClient.acquireTokenRedirect(request);
        throw redirecting;
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

  async function arm(path, options = {}, operation) {
    return requestJson(`${ARM}${path}`, options, await token([ARM_SCOPE], operation));
  }

  async function graph(path, options = {}, operation) {
    return requestJson(`${GRAPH}${path}`, options, await token(GRAPH_SCOPES, operation));
  }

  function fillSelect(select, items, placeholder, valueKey, labelKey) {
    select.replaceChildren(new Option(placeholder, ""), ...items.map(item => new Option(item[labelKey], item[valueKey])));
  }

  async function loadSubscriptions(operation = "loadSubscriptions") {
    setStatus("Loading Azure subscriptions…");
    const result = await arm(`/subscriptions?api-version=${apiVersions.resources}`, {}, operation);
    const subscriptions = (result.value || []).filter(item => item.state === "Enabled");
    fillSelect(el.subscription, subscriptions, "Choose a subscription", "subscriptionId", "displayName");
    setStatus(subscriptions.length ? "Signed in. Choose where to install the runner." : "No enabled Azure subscriptions are available to this account.", subscriptions.length ? "success" : "error");
  }

  async function loadResourceGroups(operation = "loadResourceGroups") {
    const subscriptionId = el.subscription.value;
    fillSelect(el["resource-group"], [], subscriptionId ? "Loading…" : "Choose a subscription", "name", "name");
    refreshControls();
    if (!subscriptionId) return;
    const result = await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups?api-version=${apiVersions.resources}`, {}, operation);
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

  async function grantApplicationPermissions(principalId) {
    setStatus("Finding the required Microsoft Graph application roles…");
    const result = await graph(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APP_ID}'`)}&$select=id,appRoles`);
    const graphPrincipal = result.value?.[0];
    if (!graphPrincipal) throw new Error("Microsoft Graph service principal was not found in this tenant.");
    for (const roleValue of APPLICATION_ROLES) {
      const appRole = graphPrincipal.appRoles?.find(role => role.value === roleValue && role.isEnabled && role.allowedMemberTypes?.includes("Application"));
      if (!appRole) throw new Error(`Microsoft Graph ${roleValue} application role was not found in this tenant.`);
      await grantApplicationRole(graphPrincipal, appRole, principalId);
    }
  }

  async function grantApplicationRole(graphPrincipal, appRole, principalId) {
    setStatus(`Granting ${appRole.value} to the Automation managed identity…`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await graph(`/servicePrincipals/${graphPrincipal.id}/appRoleAssignedTo`, {
          method: "POST",
          body: JSON.stringify({ principalId, resourceId: graphPrincipal.id, appRoleId: appRole.id })
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
      await token([ARM_SCOPE], "install");
      await token(GRAPH_SCOPES, "install");
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
      await grantApplicationPermissions(principalId);
      localStorage.setItem(RUNNER_STORAGE_KEY, JSON.stringify({ tenantId: account.tenantId, subscriptionId, resourceGroup, automationAccountName, runbookName: config.runbookName }));
      setStatus("Runner is ready. Mail and OneDrive sharing permissions were granted.", "success");
    } finally {
      setBusy(false);
    }
  }

  async function runOperation(payloadPath, operation, label) {
    const runner = getRunner();
    if (!runner || runner.tenantId !== account.tenantId) throw new Error("Install the runner in this tenant first.");
    setBusy(true);
    try {
      await token([ARM_SCOPE], operation);
      const jobId = crypto.randomUUID();
      const path = `/subscriptions/${encodeURIComponent(runner.subscriptionId)}/resourcegroups/${encodeURIComponent(runner.resourceGroup)}/providers/Microsoft.Automation/automationAccounts/${encodeURIComponent(runner.automationAccountName)}/jobs/${jobId}?api-version=${apiVersions.automation}`;
      setStatus("Starting the existing Automation runbook…");
      await arm(path, { method: "PUT", body: JSON.stringify({ properties: { runbook: { name: runner.runbookName }, parameters: { LabPath: payloadPath } } }) });
      setStatus(`${label} job started. Azure job ID: ${jobId}`, "success");
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
    setAuthorizationSummary();
  }

  async function resumePendingOperation(pending) {
    restoreForm(pending.form);
    switch (pending.operation) {
      case "loadSubscriptions":
        await loadSubscriptions();
        return;
      case "loadResourceGroups":
        await loadSubscriptions();
        el.subscription.value = pending.form.subscriptionId || "";
        await loadResourceGroups();
        if (pending.form.resourceGroup) el["resource-group"].value = pending.form.resourceGroup;
        refreshControls();
        return;
      case "install":
        await loadSubscriptions();
        el.subscription.value = pending.form.subscriptionId || "";
        await loadResourceGroups();
        el["resource-group"].value = pending.form.resourceGroup || "";
        refreshControls();
        await installRunner();
        return;
      case "sendEmail":
        await runOperation("payloads/send-email.ps1", "sendEmail", "Email");
        return;
      case "shareOneDriveFile":
        await runOperation("payloads/share-onedrive-file.ps1", "shareOneDriveFile", "OneDrive file sharing");
        return;
      case "sendMessageBatch":
        await runOperation("payloads/send-message-batch.ps1", "sendMessageBatch", "Message batch");
        return;
      case "sendCustomerPaymentExport":
        await runOperation("payloads/send-customer-payment-export.ps1", "sendCustomerPaymentExport", "Customer payment export");
        return;
      default:
        setStatus("Signed in. Choose an action to authorize and continue.", "success");
    }
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
    if (cachedAccount) {
      await signedIn(cachedAccount);
      const pending = takePendingOperation();
      if (pending && redirectResult) await resumePendingOperation(pending);
      else setStatus("Signed in. Choose an Azure action when you are ready to authorize it.", "success");
    } else {
      takePendingOperation();
      setStatus("Ready to sign in.");
    }
  }

  async function handleAction(action) {
    try {
      await action();
    } catch (error) {
      if (error !== redirecting) setStatus(explainError(error), "error");
    }
  }

  el["sign-in"].addEventListener("click", () => handleAction(async () => {
    setStatus("Redirecting to Microsoft to sign in…");
    await msalClient.loginRedirect({ scopes: ["openid", "profile"] });
  }));
  el["sign-out"].addEventListener("click", () => {
    sessionStorage.removeItem(PENDING_OPERATION_KEY);
    return msalClient.logoutRedirect({ account });
  });
  el["authorize-azure"].addEventListener("click", () => handleAction(() => loadSubscriptions()));
  el.subscription.addEventListener("change", () => handleAction(() => loadResourceGroups()));
  el["resource-group"].addEventListener("change", refreshControls);
  el.location.addEventListener("input", refreshControls);
  el["automation-name"].addEventListener("input", refreshControls);
  el.install.addEventListener("click", () => handleAction(installRunner));
  el.run.addEventListener("click", () => handleAction(() => runOperation("payloads/send-email.ps1", "sendEmail", "Email")));
  el["run-file-share"].addEventListener("click", () => handleAction(() => runOperation("payloads/share-onedrive-file.ps1", "shareOneDriveFile", "OneDrive file sharing")));
  el["run-email-triage"].addEventListener("click", () => handleAction(() => runOperation("payloads/send-message-batch.ps1", "sendMessageBatch", "Message batch")));
  el["run-customer-payment-export"].addEventListener("click", () => handleAction(() => runOperation("payloads/send-customer-payment-export.ps1", "sendCustomerPaymentExport", "Customer payment export")));
  initialize().catch(error => setStatus(explainError(error), "error"));
})();
