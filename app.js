"use strict";

(() => {
  const config = window.AFTER_PARTY_CONFIG;
  const automation = window.AfterPartyAutomation;
  const ARM = "https://management.azure.com";
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
  const APPLICATION_ROLES = Object.freeze(["Mail.Send", "Files.ReadWrite.All", "User.ReadWrite.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "LicenseAssignment.Read.All", "LicenseAssignment.ReadWrite.All"]);
  const ARM_SCOPE = "https://management.azure.com/user_impersonation";
  const GRAPH_SCOPES = ["Application.Read.All", "AppRoleAssignment.ReadWrite.All"];
  const RUNNER_STORAGE_KEY = "afterParty.runner.v2";
  const PENDING_OPERATION_KEY = "afterParty.pendingOperation.v1";
  const JOB_POLL_INTERVAL_MS = 1000;
  const apiVersions = Object.freeze({ resources: "2021-04-01", deployments: "2022-09-01", automation: automation.API_VERSION });
  const el = Object.fromEntries([
    "configuration-warning", "status", "sign-in", "sign-out", "account", "authorization", "authorize-azure",
    "subscription", "resource-group", "environment-status", "install", "run", "run-file-share", "run-email-triage",
    "run-customer-payment-export", "run-external-email", "run-tenant-seed", "email-job-status", "file-share-job-status", "message-batch-job-status", "payment-export-job-status", "external-email-job-status", "tenant-seed-job-status", "diagnostics"
  ].map(id => [id, document.getElementById(id)]));
  let msalClient;
  let account;
  let busy = false;
  let activeRunner = null;
  let deploymentInfo = null;
  const activeOperations = new Set();
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

  function setEnvironment(message, kind = "") {
    if (!el["environment-status"]) return;
    el["environment-status"].textContent = message;
    el["environment-status"].className = `environment-status ${kind}`.trim();
  }

  function setJobStatus(element, message, kind = "", output = "") {
    if (!element) {
      setStatus(message, kind);
      return;
    }
    element.hidden = false;
    element.className = `job-status ${kind}`.trim();
    element.replaceChildren(document.createTextNode(message));
    if (output) {
      const pre = document.createElement("pre");
      pre.textContent = output.length > 4000 ? `${output.slice(-4000)}\n…output truncated` : output;
      element.append(pre);
    }
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
    return { subscriptionId: el.subscription.value, resourceGroup: el["resource-group"].value };
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

  function getStoredRunner() {
    try { return JSON.parse(localStorage.getItem(RUNNER_STORAGE_KEY)); } catch { return null; }
  }

  function currentRunner() {
    if (activeRunner?.tenantId === account?.tenantId) return activeRunner;
    const stored = getStoredRunner();
    if (stored?.tenantId === account?.tenantId && stored.subscriptionId === el.subscription.value && stored.resourceGroup === el["resource-group"].value) return stored;
    return null;
  }

  function storeRunner(runner) {
    activeRunner = runner;
    localStorage.setItem(RUNNER_STORAGE_KEY, JSON.stringify(runner));
    setDiagnostics();
  }

  function buildVersion(key) {
    return window.AFTER_PARTY_BUILD?.[key] || "unknown";
  }

  function setDiagnostics() {
    if (!el.diagnostics) return;
    const runner = currentRunner();
    const runnerVersion = runner?.runnerVersion || "not detected";
    const deployment = deploymentInfo?.unavailable
      ? " · GitHub Pages deployment details are unavailable."
      : deploymentInfo
        ? ` · Deployed commit: ${deploymentInfo.commit.slice(0, 12)} · Deployment time: ${new Date(deploymentInfo.deployedAt).toLocaleString()}`
        : " · GitHub Pages deployment: checking…";
    el.diagnostics.textContent = `Site version: ${buildVersion("siteVersion")} · Current runner version: ${buildVersion("runnerVersion")} · Detected runner version: ${runnerVersion}${deployment}`;
  }

  async function loadDeploymentInfo() {
    try {
      const response = await fetch(`deployment.json?nonce=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`deployment manifest returned ${response.status}`);
      const value = await response.json();
      if (typeof value.commit !== "string" || !value.commit || Number.isNaN(Date.parse(value.deployedAt))) throw new Error("deployment manifest is incomplete");
      deploymentInfo = value;
    } catch {
      deploymentInfo = { unavailable: true };
    }
    setDiagnostics();
  }

  function refreshControls() {
    const signedIn = Boolean(account);
    const environmentSelected = Boolean(el.subscription.value && el["resource-group"].value);
    const ready = Boolean(currentRunner());
    el["sign-in"].hidden = signedIn;
    el["sign-out"].hidden = !signedIn;
    el["authorize-azure"].disabled = busy || !signedIn;
    el.subscription.disabled = busy || !signedIn;
    el["resource-group"].disabled = busy || !signedIn || !el.subscription.value;
    el.install.disabled = busy || !signedIn || !environmentSelected;
    el.install.textContent = ready ? "Update environment" : "Set up environment";
    Object.entries({
      sendEmail: el.run,
      shareOneDriveFile: el["run-file-share"],
      sendMessageBatch: el["run-email-triage"],
      sendCustomerPaymentExport: el["run-customer-payment-export"],
      sendExternalEmail: el["run-external-email"],
      seedTenant: el["run-tenant-seed"]
    }).forEach(([operation, button]) => {
      if (button) button.disabled = busy || !signedIn || !ready || activeOperations.size > 0;
    });
    setDiagnostics();
  }

  function noteAuthorized(scopes) {
    if (scopes.includes(ARM_SCOPE)) authorization.arm = true;
    if (scopes.some(scope => GRAPH_SCOPES.includes(scope))) authorization.graph = true;
    setAuthorizationSummary();
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

  async function armText(path) {
    const response = await fetch(`${ARM}${path}`, { headers: { Authorization: `Bearer ${await token([ARM_SCOPE])}` } });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `${response.status} ${response.statusText}`);
    return text.trim().replace(/^"|"$/g, "");
  }

  async function graph(path, options = {}, operation) {
    return requestJson(`${GRAPH}${path}`, options, await token(GRAPH_SCOPES, operation));
  }

  function fillSelect(select, items, placeholder, valueKey, labelKey) {
    select.replaceChildren(new Option(placeholder, ""), ...items.map(item => new Option(item[labelKey], item[valueKey])));
  }

  function runnerName() {
    return `after-party-${account.tenantId}`;
  }

  async function loadSubscriptions(operation = "loadSubscriptions") {
    setStatus("Loading Azure subscriptions…");
    const result = await arm(`/subscriptions?api-version=${apiVersions.resources}`, {}, operation);
    const subscriptions = (result.value || []).filter(item => item.state === "Enabled");
    fillSelect(el.subscription, subscriptions, "Choose a subscription", "subscriptionId", "displayName");
    if (subscriptions.length === 1) {
      el.subscription.value = subscriptions[0].subscriptionId;
      await loadResourceGroups();
      return;
    }
    setStatus(subscriptions.length ? "Choose the subscription for this environment." : "No enabled Azure subscriptions are available to this account.", subscriptions.length ? "success" : "error");
  }

  async function loadResourceGroups(operation = "loadResourceGroups") {
    const subscriptionId = el.subscription.value;
    activeRunner = null;
    fillSelect(el["resource-group"], [], subscriptionId ? "Loading…" : "Choose a subscription", "name", "name");
    setEnvironment("Choose a resource group to check the environment.");
    refreshControls();
    if (!subscriptionId) return;
    const result = await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups?api-version=${apiVersions.resources}`, {}, operation);
    const groups = result.value || [];
    fillSelect(el["resource-group"], groups, "Choose a resource group", "name", "name");
    if (groups.length === 1) {
      el["resource-group"].value = groups[0].name;
      await discoverRunner();
      return;
    }
    refreshControls();
  }

  async function discoverRunner(operation = "discoverRunner") {
    const subscriptionId = el.subscription.value;
    const resourceGroup = el["resource-group"].value;
    activeRunner = null;
    if (!subscriptionId || !resourceGroup) {
      setEnvironment("Choose a resource group to check the environment.");
      refreshControls();
      return;
    }
    setEnvironment("Checking for an existing After Party environment…");
    refreshControls();
    const runner = await automation.findRunner({
      requestJson: (path, options = {}) => arm(path, options, operation),
      subscriptionId,
      resourceGroup,
      runbookName: config.runbookName
    });
    if (runner) {
      runner.tenantId = account.tenantId;
      storeRunner(runner);
      setEnvironment(`Ready — using the existing After Party Automation account “${runner.automationAccountName}”. No setup is required when you return.`, "ready");
      refreshControls();
      return;
    }
    setEnvironment("No After Party environment was found in this resource group. Set it up once to continue.");
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
    const assignments = await getExistingApplicationAssignments(principalId);
    const existingRoleIds = new Set((assignments.value || [])
      .filter(assignment => assignment.resourceId?.toLowerCase() === graphPrincipal.id.toLowerCase())
      .map(assignment => assignment.appRoleId));
    const requiredRoles = [];
    for (const roleValue of APPLICATION_ROLES) {
      const appRole = graphPrincipal.appRoles?.find(role => role.value === roleValue && role.isEnabled && role.allowedMemberTypes?.includes("Application"));
      if (!appRole) throw new Error(`Microsoft Graph ${roleValue} application role was not found in this tenant.`);
      requiredRoles.push(appRole);
      if (existingRoleIds.has(appRole.id)) continue;
      await grantApplicationRole(graphPrincipal, appRole, principalId);
    }
    await verifyApplicationPermissions(principalId, graphPrincipal, requiredRoles);
  }

  async function verifyApplicationPermissions(principalId, graphPrincipal, requiredRoles) {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      const assignments = await getExistingApplicationAssignments(principalId);
      const assignedRoleIds = new Set((assignments.value || [])
        .filter(assignment => assignment.resourceId?.toLowerCase() === graphPrincipal.id.toLowerCase())
        .map(assignment => assignment.appRoleId));
      const missing = requiredRoles.filter(role => !assignedRoleIds.has(role.id));
      if (!missing.length) return;
      if (attempt === 14) throw new Error(`The Automation managed identity is missing required Microsoft Graph application roles: ${missing.map(role => role.value).join(", ")}.`);
      setStatus(`Waiting for Microsoft Graph to confirm ${missing.length} application role assignment(s)…`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  async function getExistingApplicationAssignments(principalId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        return await graph(`/servicePrincipals/${principalId}/appRoleAssignments?$select=appRoleId,resourceId`);
      } catch (error) {
        const identityNotReady = error.status === 404 && /(principal|service principal|not found)/i.test(explainError(error));
        if (!identityNotReady || attempt === 29) throw error;
        setStatus("Waiting for the new managed identity to appear in Microsoft Entra…");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async function grantApplicationRole(graphPrincipal, appRole, principalId) {
    setStatus(`Granting ${appRole.value} to the Automation managed identity…`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await graph(`/servicePrincipals/${graphPrincipal.id}/appRoleAssignedTo`, { method: "POST", body: JSON.stringify({ principalId, resourceId: graphPrincipal.id, appRoleId: appRole.id }) });
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
      const automationAccountName = currentRunner()?.automationAccountName || runnerName();
      await token([ARM_SCOPE], "install");
      await token(GRAPH_SCOPES, "install");
      setStatus(`Configuring the After Party Automation account “${automationAccountName}”…`);
      await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Automation/register?api-version=${apiVersions.resources}`, { method: "POST" });
      const template = await requestJson(`azuredeploy.json?v=${encodeURIComponent(buildVersion("runnerVersion"))}`, { cache: "no-store" });
      const deploymentName = `after-party-${Date.now()}`;
      const deploymentPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=${apiVersions.deployments}`;
      await arm(deploymentPath, { method: "PUT", body: JSON.stringify({ properties: { mode: "Incremental", template, parameters: {
        automationAccountName: { value: automationAccountName },
        bootstrapUri: { value: `${config.repositoryRawBase}/runbooks/bootstrap.ps1?version=${encodeURIComponent(buildVersion("runnerVersion"))}` },
        runnerVersion: { value: buildVersion("runnerVersion") }
      } } }) });
      const deployment = await waitForDeployment(deploymentPath);
      const principalId = deployment.properties.outputs?.managedIdentityPrincipalId?.value;
      if (!principalId) throw new Error("Deployment succeeded but did not return the managed identity principal ID.");
      await grantApplicationPermissions(principalId);
      storeRunner({ tenantId: account.tenantId, subscriptionId, resourceGroup, automationAccountName, runbookName: config.runbookName, runnerVersion: buildVersion("runnerVersion") });
      setEnvironment(`Ready — using the After Party Automation account “${automationAccountName}”.`, "ready");
      setStatus("Environment is ready.", "success");
    } finally {
      setBusy(false);
    }
  }

  async function pollJob(jobPath, statusElement, label, jobId, operation) {
    try {
      const result = await automation.waitForJob({
        requestJson: (path, options = {}) => arm(path, options),
        requestText: path => armText(path),
        jobPath,
        intervalMs: JOB_POLL_INTERVAL_MS,
        onStatus: ({ attempt, status }) => {
          if (["Completed", ...automation.TERMINAL_FAILURE_STATES].includes(status)) return;
          const spinner = ["◐", "◓", "◑", "◒"][attempt % 4];
          setJobStatus(statusElement, `${spinner} ${label}: ${status.toLowerCase()}… Job ID: ${jobId}`, status.toLowerCase());
        }
      });
      if (result.status === "Completed") {
        setJobStatus(statusElement, `${label}: completed.`, "success", result.output || "The operation completed successfully.");
      } else if (automation.TERMINAL_FAILURE_STATES.includes(result.status)) {
        const detail = result.output || result.job.properties?.statusDetails || "Azure Automation did not provide additional details.";
        setJobStatus(statusElement, `${label}: ${result.status.toLowerCase()}.`, "error", detail);
      } else {
        setJobStatus(statusElement, `${label}: status refresh timed out after 10 minutes. The button is available again; check the Automation account before starting another job.`, "error");
      }
    } finally {
      activeOperations.delete(operation);
      refreshControls();
    }
  }

  async function runOperation(payloadPath, operation, label, statusElement) {
    const runner = currentRunner();
    if (!runner) throw new Error("Select a resource group with a ready After Party environment first.");
    if (activeOperations.has(operation)) {
      setJobStatus(statusElement, `${label} is already in progress.`);
      return;
    }
    activeOperations.add(operation);
    setBusy(true);
    let jobStarted = false;
    try {
      await token([ARM_SCOPE], operation);
      const jobId = crypto.randomUUID();
      setJobStatus(statusElement, `◐ ${label}: queued… Job ID: ${jobId}`, "queued");
      const { jobPath } = await automation.startJob({ requestJson: (path, options = {}) => arm(path, options), runner, payloadPath, jobId });
      jobStarted = true;
      void pollJob(jobPath, statusElement, label, jobId, operation).catch(error => setJobStatus(statusElement, `${label}: unable to refresh status.`, "error", explainError(error)));
    } finally {
      setBusy(false);
      if (!jobStarted) {
        activeOperations.delete(operation);
        refreshControls();
      }
    }
  }

  async function signedIn(nextAccount) {
    account = nextAccount;
    msalClient.setActiveAccount(account);
    el.account.textContent = `${account.name || account.username} (${account.tenantId})`;
    refreshControls();
    setAuthorizationSummary();
  }

  async function restoreEnvironment(form = {}) {
    await loadSubscriptions();
    if (!form.subscriptionId) return;
    el.subscription.value = form.subscriptionId;
    await loadResourceGroups();
    if (!form.resourceGroup) return;
    el["resource-group"].value = form.resourceGroup;
    await discoverRunner();
  }

  async function resumePendingOperation(pending) {
    await restoreEnvironment(pending.form);
    switch (pending.operation) {
      case "loadSubscriptions":
      case "loadResourceGroups":
      case "discoverRunner":
        return;
      case "install":
        await installRunner();
        return;
      case "sendEmail":
        await runOperation("payloads/send-email.ps1", "sendEmail", "Email", el["email-job-status"]);
        return;
      case "shareOneDriveFile":
        await runOperation("payloads/share-onedrive-file.ps1", "shareOneDriveFile", "OneDrive file sharing", el["file-share-job-status"]);
        return;
      case "sendMessageBatch":
        await runOperation("payloads/send-message-batch.ps1", "sendMessageBatch", "Message batch", el["message-batch-job-status"]);
        return;
      case "sendCustomerPaymentExport":
        await runOperation("payloads/send-customer-payment-export.ps1", "sendCustomerPaymentExport", "Customer payment export", el["payment-export-job-status"]);
        return;
      case "sendExternalEmail":
        await runOperation("payloads/send-external-email.ps1", "sendExternalEmail", "External email", el["external-email-job-status"]);
        return;
      case "seedTenant":
        await runOperation("payloads/seed-tenant.ps1", "seedTenant", "Tenant preparation", el["tenant-seed-job-status"]);
        return;
    }
  }

  async function initialize() {
    void loadDeploymentInfo();
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
    try { await action(); } catch (error) { if (error !== redirecting) setStatus(explainError(error), "error"); }
  }

  function bind(id, event, handler) {
    const element = el[id];
    if (element) element.addEventListener(event, handler);
  }

  bind("sign-in", "click", () => handleAction(async () => {
    setStatus("Redirecting to Microsoft to sign in…");
    await msalClient.loginRedirect({ scopes: ["openid", "profile"] });
  }));
  bind("sign-out", "click", () => {
    sessionStorage.removeItem(PENDING_OPERATION_KEY);
    return msalClient.logoutRedirect({ account });
  });
  bind("authorize-azure", "click", () => handleAction(() => loadSubscriptions()));
  bind("subscription", "change", () => handleAction(() => loadResourceGroups()));
  bind("resource-group", "change", () => handleAction(() => discoverRunner()));
  bind("install", "click", () => handleAction(installRunner));
  bind("run", "click", () => handleAction(() => runOperation("payloads/send-email.ps1", "sendEmail", "Email", el["email-job-status"])));
  bind("run-file-share", "click", () => handleAction(() => runOperation("payloads/share-onedrive-file.ps1", "shareOneDriveFile", "OneDrive file sharing", el["file-share-job-status"])));
  bind("run-email-triage", "click", () => handleAction(() => runOperation("payloads/send-message-batch.ps1", "sendMessageBatch", "Message batch", el["message-batch-job-status"])));
  bind("run-customer-payment-export", "click", () => handleAction(() => runOperation("payloads/send-customer-payment-export.ps1", "sendCustomerPaymentExport", "Customer payment export", el["payment-export-job-status"])));
  bind("run-external-email", "click", () => handleAction(() => runOperation("payloads/send-external-email.ps1", "sendExternalEmail", "External email", el["external-email-job-status"])));
  bind("run-tenant-seed", "click", () => handleAction(() => runOperation("payloads/seed-tenant.ps1", "seedTenant", "Tenant preparation", el["tenant-seed-job-status"])));
  initialize().catch(error => setStatus(explainError(error), "error"));
})();
