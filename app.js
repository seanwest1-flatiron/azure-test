"use strict";

(() => {
  const config = window.AFTER_PARTY_CONFIG;
  const automation = window.AfterPartyAutomation;
  const armRetry = window.AfterPartyArmRetry;
  const updateGateApi = window.AfterPartyUpdateGate;
  const loadedDeployment = window.AFTER_PARTY_LOADED_DEPLOYMENT;
  const runnerPermissions = window.AfterPartyRunnerPermissions;
  const prerequisiteApi = window.AfterPartyPrerequisites;
  const ARM = "https://management.azure.com";
  const GRAPH = "https://graph.microsoft.com/v1.0";
  const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
  const CORE_APPLICATION_ROLES = Object.freeze(["Mail.Send", "Files.ReadWrite.All", "User.ReadWrite.All", "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "LicenseAssignment.Read.All", "LicenseAssignment.ReadWrite.All", "GroupSettings.ReadWrite.All", "AuditLog.Read.All", "Domain.Read.All", "Application.ReadWrite.All"]);
  const LAB_APPLICATION_ROLES = Object.freeze({
    failedSignInDetection: Object.freeze(["CustomDetection.ReadWrite.All"]),
    resetLisaPassword: Object.freeze(["User-PasswordProfile.ReadWrite.All"])
  });
  const ARM_SCOPE = "https://management.azure.com/user_impersonation";
  const GRAPH_SCOPES = ["Application.Read.All", "AppRoleAssignment.ReadWrite.All"];
  const RUNNER_STORAGE_KEY = "afterParty.runner.v2";
  const PENDING_OPERATION_KEY = "afterParty.pendingOperation.v1";
  const JOB_POLL_INTERVAL_MS = 1000;
  const apiVersions = Object.freeze({ resources: "2021-04-01", deployments: "2022-09-01", automation: automation.API_VERSION });
  const el = Object.fromEntries([
    "configuration-warning", "status", "sign-in", "sign-out", "account-menu", "account-button", "account-name", "account-username", "account-tenant", "account-environment",
    "update-dialog", "update-refresh", "update-cancel", "environment-chooser", "environment-chooser-title", "environment-chooser-message", "environment-cancel", "environment-continue", "subscription-field", "resource-group-field",
    "subscription", "resource-group", "run", "run-file-share", "run-email-triage",
    "run-customer-payment-export", "run-external-email", "run-failed-sign-in", "run-failed-sign-in-three", "run-failed-sign-in-detection", "run-browser-failed-sign-in", "run-browser-failed-sign-in-three", "run-reset-lisa-password", "email-job-status", "file-share-job-status", "message-batch-job-status", "payment-export-job-status", "external-email-job-status", "failed-sign-in-job-status", "failed-sign-in-three-job-status", "failed-sign-in-detection-job-status", "browser-failed-sign-in-job-status", "browser-failed-sign-in-three-job-status", "reset-lisa-password-job-status", "diagnostics"
  ].map(id => [id, document.getElementById(id)]));
  let msalClient;
  let account;
  let busy = false;
  let activeRunner = null;
  let deploymentInfo = loadedDeployment || null;
  let frontendUpdateGate;
  let prerequisiteFlow;
  let prerequisiteStatusElement = null;
  const activeOperations = new Set();
  const authorization = { arm: false, graph: false };
  const redirecting = Symbol("redirecting");
  const labs = Object.freeze({
    sendEmail: { operation: "sendEmail", payloadPath: "payloads/send-email.ps1", label: "Email", statusId: "email-job-status" },
    shareOneDriveFile: { operation: "shareOneDriveFile", payloadPath: "payloads/share-onedrive-file.ps1", label: "OneDrive file sharing", statusId: "file-share-job-status" },
    sendMessageBatch: { operation: "sendMessageBatch", payloadPath: "payloads/send-message-batch.ps1", label: "Message batch", statusId: "message-batch-job-status" },
    sendCustomerPaymentExport: { operation: "sendCustomerPaymentExport", payloadPath: "payloads/send-customer-payment-export.ps1", label: "Customer payment export", statusId: "payment-export-job-status" },
    sendExternalEmail: { operation: "sendExternalEmail", payloadPath: "payloads/send-external-email.ps1", label: "External email", statusId: "external-email-job-status" },
    failedSignIn: { operation: "failedSignIn", payloadPath: "payloads/failed-sign-in.ps1", label: "Failed sign-in", statusId: "failed-sign-in-job-status" },
    failedSignInThree: { operation: "failedSignInThree", payloadPath: "payloads/failed-sign-in.ps1", label: "Three non-interactive failed sign-ins", statusId: "failed-sign-in-three-job-status", parameters: Object.freeze({ AttemptCount: "3" }) },
    failedSignInDetection: { operation: "failedSignInDetection", payloadPath: "payloads/create-failed-sign-in-detection.ps1", label: "Toggle failed sign-in detection", statusId: "failed-sign-in-detection-job-status" },
    browserFailedSignIn: { operation: "browserFailedSignIn", payloadPath: "payloads/browser-failed-sign-in.ps1", label: "Browser failed sign-in", statusId: "browser-failed-sign-in-job-status" },
    browserFailedSignInThree: { operation: "browserFailedSignInThree", payloadPath: "payloads/browser-failed-sign-in.ps1", label: "Three browser failed sign-ins", statusId: "browser-failed-sign-in-three-job-status", parameters: { AttemptCount: "3" } },
    resetLisaPassword: { operation: "resetLisaPassword", payloadPath: "payloads/reset-lisa-password.ps1", label: "Reset Lisa Simpson password", statusId: "reset-lisa-password-job-status" }
  });

  function setStatus(message, kind = "") {
    el.status.textContent = message;
    el.status.className = `notice ${kind}`.trim();
    el.status.hidden = !message;
  }

  function clearStatus() {
    setStatus("");
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
    setStatus(message, kind);
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
      const details = document.createElement("details");
      details.className = "job-technical-details";
      const summary = document.createElement("summary");
      summary.textContent = "Technical details";
      const pre = document.createElement("pre");
      pre.textContent = output.length > 4000 ? `${output.slice(-4000)}\n…output truncated` : output;
      details.append(summary, pre);
      element.append(details);
    }
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

  function runnerSummary() {
    const current = currentRunner();
    if (current) return current;
    const stored = getStoredRunner();
    const selectedEnvironmentMatches = (!el.subscription.value || stored?.subscriptionId === el.subscription.value)
      && (!el["resource-group"].value || stored?.resourceGroup === el["resource-group"].value);
    return stored?.tenantId === account?.tenantId && selectedEnvironmentMatches ? stored : null;
  }

  function storeRunner(runner) {
    activeRunner = runner;
    localStorage.setItem(RUNNER_STORAGE_KEY, JSON.stringify(runner));
    setAccountSummary();
    setDiagnostics();
  }

  function buildVersion(key) {
    return window.AFTER_PARTY_BUILD?.[key] || "unknown";
  }

  function setDiagnostics() {
    if (!el.diagnostics) return;
    const runner = runnerSummary();
    const runnerVersion = runner?.runnerVersion || "not detected";
    const baselineVersion = runner?.tenantBaselineVersion || "not applied";
    const deployment = deploymentInfo?.unavailable
      ? " · GitHub Pages deployment details are unavailable."
      : deploymentInfo
        ? ` · Deployed commit: ${deploymentInfo.commit.slice(0, 12)} · Deployment time: ${new Date(deploymentInfo.deployedAt).toLocaleString()}`
        : " · GitHub Pages deployment: checking…";
    const subscription = runner?.subscriptionId || el.subscription.value || "not selected";
    const resourceGroup = runner?.resourceGroup || el["resource-group"].value || "not selected";
    const automationAccount = runner?.automationAccountName || "not detected";
    el.diagnostics.textContent = `Site: ${buildVersion("siteVersion")} · Desired runner: ${buildVersion("runnerVersion")} · Detected runner: ${runnerVersion} · Desired baseline: ${buildVersion("tenantBaselineVersion")} · Applied baseline: ${baselineVersion} · Subscription: ${subscription} · Resource group: ${resourceGroup} · Automation account: ${automationAccount}${deployment}`;
  }

  function setAccountSummary() {
    if (!account) return;
    const displayName = account.name || account.username;
    const runner = runnerSummary();
    const subscriptionLabel = el.subscription.selectedOptions?.[0]?.textContent || runner?.subscriptionId;
    el["account-button"].textContent = displayName;
    el["account-name"].textContent = account.name || "Microsoft account";
    el["account-username"].textContent = account.username || "";
    el["account-tenant"].textContent = account.tenantId ? `Tenant: ${account.tenantId}` : "";
    el["account-environment"].textContent = runner
      ? `${subscriptionLabel || runner.subscriptionId} · ${runner.resourceGroup} · ${runner.automationAccountName}`
      : "The environment will be selected when a lab starts.";
  }

  async function fetchDeploymentInfo() {
    const response = await fetch(`deployment.json?nonce=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`deployment manifest returned ${response.status}`);
    const value = await response.json();
    if (typeof value.commit !== "string" || !value.commit || Number.isNaN(Date.parse(value.deployedAt))) throw new Error("deployment manifest is incomplete");
    deploymentInfo = value;
    setDiagnostics();
    return value;
  }

  function promptForFrontendRefresh() {
    const dialog = el["update-dialog"];
    return new Promise(resolve => {
      const finish = decision => {
        el["update-refresh"].removeEventListener("click", refreshChoice);
        el["update-cancel"].removeEventListener("click", cancelChoice);
        dialog.removeEventListener("cancel", cancelDialog);
        if (dialog.open) dialog.close();
        dialog.hidden = true;
        resolve(decision);
      };
      const refreshChoice = () => finish("refresh");
      const cancelChoice = () => finish("cancel");
      const cancelDialog = event => { event.preventDefault(); finish("cancel"); };
      el["update-refresh"].addEventListener("click", refreshChoice);
      el["update-cancel"].addEventListener("click", cancelChoice);
      dialog.addEventListener("cancel", cancelDialog);
      dialog.hidden = false;
      dialog.showModal();
      el["update-refresh"].focus();
    });
  }

  function refreshControls() {
    const signedIn = Boolean(account);
    el["sign-in"].hidden = signedIn;
    el["account-menu"].hidden = !signedIn;
    Object.entries({
      sendEmail: el.run,
      shareOneDriveFile: el["run-file-share"],
      sendMessageBatch: el["run-email-triage"],
      sendCustomerPaymentExport: el["run-customer-payment-export"],
      sendExternalEmail: el["run-external-email"],
      failedSignIn: el["run-failed-sign-in"],
      failedSignInThree: el["run-failed-sign-in-three"],
      failedSignInDetection: el["run-failed-sign-in-detection"],
      browserFailedSignIn: el["run-browser-failed-sign-in"],
      browserFailedSignInThree: el["run-browser-failed-sign-in-three"],
      resetLisaPassword: el["run-reset-lisa-password"]
    }).forEach(([operation, button]) => {
      if (button) button.disabled = busy || activeOperations.size > 0;
    });
    setAccountSummary();
    setDiagnostics();
  }

  function noteAuthorized(scopes) {
    if (scopes.includes(ARM_SCOPE)) authorization.arm = true;
    if (scopes.some(scope => GRAPH_SCOPES.includes(scope))) authorization.graph = true;
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
    const accessToken = await token([ARM_SCOPE], operation);
    return armRetry.retryArmRequest(
      () => requestJson(`${ARM}${path}`, options, accessToken),
      { method: options.method || "GET" }
    );
  }

  async function armText(path) {
    const accessToken = await token([ARM_SCOPE]);
    return armRetry.retryArmRequest(async () => {
      const response = await fetch(`${ARM}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      const text = await response.text();
      if (!response.ok) {
        const error = new Error(text || `${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
      }
      return text.trim().replace(/^"|"$/g, "");
    }, { method: "GET" });
  }

  async function graph(path, options = {}, operation) {
    return requestJson(`${GRAPH}${path}`, options, await token(GRAPH_SCOPES, operation));
  }

  function fillSelect(select, items, placeholder, valueKey, labelKey) {
    select.replaceChildren(new Option(placeholder, ""), ...items.map(item => new Option(item[labelKey], item[valueKey])));
  }

  function chooseEnvironmentOption({ type, title, message }) {
    const dialog = el["environment-chooser"];
    const select = type === "subscription" ? el.subscription : el["resource-group"];
    el["environment-chooser-title"].textContent = title;
    el["environment-chooser-message"].textContent = message;
    el["subscription-field"].hidden = type !== "subscription";
    el["resource-group-field"].hidden = type !== "resourceGroup";
    el["environment-continue"].disabled = !select.value;

    return new Promise((resolve, reject) => {
      const finish = value => {
        el["environment-continue"].removeEventListener("click", continueChoice);
        el["environment-cancel"].removeEventListener("click", cancelChoice);
        select.removeEventListener("change", updateChoice);
        dialog.removeEventListener("cancel", cancelDialog);
        if (dialog.open) dialog.close();
        dialog.hidden = true;
        value ? resolve(value) : reject(new Error("Environment selection was canceled."));
      };
      const continueChoice = () => { if (select.value) finish(select.value); };
      const cancelChoice = () => finish("");
      const cancelDialog = event => { event.preventDefault(); finish(""); };
      const updateChoice = () => { el["environment-continue"].disabled = !select.value; };
      el["environment-continue"].addEventListener("click", continueChoice);
      el["environment-cancel"].addEventListener("click", cancelChoice);
      select.addEventListener("change", updateChoice);
      dialog.addEventListener("cancel", cancelDialog);
      dialog.hidden = false;
      dialog.showModal();
      select.focus();
    });
  }

  function runnerName() {
    return `after-party-${account.tenantId}`;
  }

  async function loadSubscriptions(operation = "loadSubscriptions", continueAutomatically = true) {
    setStatus("Loading Azure subscriptions…");
    const result = await arm(`/subscriptions?api-version=${apiVersions.resources}`, {}, operation);
    const subscriptions = (result.value || []).filter(item => item.state === "Enabled");
    fillSelect(el.subscription, subscriptions, "Choose a subscription", "subscriptionId", "displayName");
    if (!subscriptions.length) {
      setStatus("No enabled Azure subscriptions are available to this account.", "error");
      return subscriptions;
    }
    if (continueAutomatically && subscriptions.length === 1) {
      el.subscription.value = subscriptions[0].subscriptionId;
      await loadResourceGroups();
      return subscriptions;
    }
    return subscriptions;
  }

  async function loadResourceGroups(operation = "loadResourceGroups", continueAutomatically = true) {
    const subscriptionId = el.subscription.value;
    activeRunner = null;
    fillSelect(el["resource-group"], [], subscriptionId ? "Loading…" : "Choose a subscription", "name", "name");
    setEnvironment("Choose a resource group to check the environment.");
    refreshControls();
    if (!subscriptionId) return;
    const result = await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups?api-version=${apiVersions.resources}`, {}, operation);
    const groups = result.value || [];
    fillSelect(el["resource-group"], groups, "Choose a resource group", "name", "name");
    if (!groups.length) {
      setStatus("No Azure resource groups are available in this subscription.", "error");
      return groups;
    }
    if (continueAutomatically && groups.length === 1) {
      el["resource-group"].value = groups[0].name;
      await discoverRunner(operation);
    }
    refreshControls();
    return groups;
  }

  async function discoverRunner(operation = "discoverRunner") {
    const subscriptionId = el.subscription.value;
    const resourceGroup = el["resource-group"].value;
    activeRunner = null;
    if (!subscriptionId || !resourceGroup) {
      setEnvironment("Choose a resource group to check the environment.");
      refreshControls();
      return null;
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
      return runner;
    }
    setEnvironment("No After Party environment was found in this resource group. Set it up once to continue.");
    refreshControls();
    return null;
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

  function applicationRolesForOperation(operation) {
    return [...new Set([...CORE_APPLICATION_ROLES, ...(LAB_APPLICATION_ROLES[operation] || [])])];
  }

  async function grantApplicationPermissions(principalId, operation, requiredRoleValues = CORE_APPLICATION_ROLES) {
    if (!runnerPermissions) throw new Error("runner-permissions.js is missing or did not load.");
    setStatus("Finding the required Microsoft Graph application roles…");
    const result = await graph(`/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${GRAPH_APP_ID}'`)}&$select=id,appRoles`, {}, operation);
    const graphPrincipal = result.value?.[0];
    if (!graphPrincipal) throw new Error("Microsoft Graph service principal was not found in this tenant.");
    return runnerPermissions.reconcileApplicationRoles({
      requiredRoleValues,
      graphPrincipal,
      getAssignments: () => getExistingApplicationAssignments(principalId, operation),
      assignRole: appRole => grantApplicationRole(graphPrincipal, appRole, principalId, operation),
      onWaiting: missing => setStatus(`Waiting for Microsoft Graph to confirm ${missing.length} application role assignment(s)…`)
    });
  }

  async function getExistingApplicationAssignments(principalId, operation) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        return await graph(`/servicePrincipals/${principalId}/appRoleAssignments?$select=appRoleId,resourceId`, {}, operation);
      } catch (error) {
        const identityNotReady = error.status === 404 && /(principal|service principal|not found)/i.test(explainError(error));
        if (!identityNotReady || attempt === 29) throw error;
        setStatus("Waiting for the new managed identity to appear in Microsoft Entra…");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async function grantApplicationRole(graphPrincipal, appRole, principalId, operation) {
    setStatus(`Granting ${appRole.value} to the Automation managed identity…`);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await graph(`/servicePrincipals/${graphPrincipal.id}/appRoleAssignedTo`, { method: "POST", body: JSON.stringify({ principalId, resourceId: graphPrincipal.id, appRoleId: appRole.id }) }, operation);
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

  async function installRunner(operation = "install", existingRunner = currentRunner(), manageBusy = true) {
    if (manageBusy) setBusy(true);
    try {
      const subscriptionId = el.subscription.value;
      const resourceGroup = el["resource-group"].value;
      const automationAccountName = existingRunner?.automationAccountName || runnerName();
      await token([ARM_SCOPE], operation);
      await token(GRAPH_SCOPES, operation);
      setStatus(`Configuring the After Party Automation account “${automationAccountName}”…`);
      await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.Automation/register?api-version=${apiVersions.resources}`, { method: "POST" });
      await arm(`/subscriptions/${encodeURIComponent(subscriptionId)}/providers/Microsoft.ContainerInstance/register?api-version=${apiVersions.resources}`, { method: "POST" });
      const template = await requestJson(`azuredeploy.json?v=${encodeURIComponent(buildVersion("runnerVersion"))}`, { cache: "no-store" });
      const deploymentName = `after-party-${Date.now()}`;
      const deploymentPath = `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Resources/deployments/${deploymentName}?api-version=${apiVersions.deployments}`;
      await arm(deploymentPath, { method: "PUT", body: JSON.stringify({ properties: { mode: "Incremental", template, parameters: {
        automationAccountName: { value: automationAccountName },
        bootstrapUri: { value: `${config.repositoryRawBase}/runbooks/bootstrap.ps1?version=${encodeURIComponent(buildVersion("runnerVersion"))}` },
        runnerVersion: { value: buildVersion("runnerVersion") },
        tenantBaselineVersion: { value: existingRunner?.tenantBaselineVersion || "" }
      } } }) });
      const deployment = await waitForDeployment(deploymentPath);
      const principalId = deployment.properties.outputs?.managedIdentityPrincipalId?.value;
      if (!principalId) throw new Error("Deployment succeeded but did not return the managed identity principal ID.");
      await grantApplicationPermissions(principalId, operation);
      const runner = { tenantId: account.tenantId, subscriptionId, resourceGroup, automationAccountName, runbookName: config.runbookName, principalId, runnerVersion: buildVersion("runnerVersion"), tenantBaselineVersion: existingRunner?.tenantBaselineVersion || "" };
      storeRunner(runner);
      setEnvironment(`Ready — using the After Party Automation account “${automationAccountName}”.`, "ready");
      setStatus("Environment is ready.", "success");
      return runner;
    } finally {
      if (manageBusy) setBusy(false);
    }
  }

  async function reconcileRunnerPermissions(lab, runner) {
    const accountPath = automation.accountPath(runner.subscriptionId, runner.resourceGroup, runner.automationAccountName);
    const accountDetails = runner.principalId
      ? null
      : await arm(`${accountPath}?api-version=${apiVersions.automation}`, {}, lab.operation);
    const principalId = runner.principalId || accountDetails?.identity?.principalId;
    if (!principalId) throw new Error("The Automation account did not expose its managed identity principal ID.");
    await token(GRAPH_SCOPES, lab.operation);
    const result = await grantApplicationPermissions(principalId, lab.operation, applicationRolesForOperation(lab.operation));
    if (result.addedRoles.length) {
      setStatus(`Assigned ${result.addedRoles.length} missing managed-identity permission${result.addedRoles.length === 1 ? "" : "s"}. Azure Automation will wait briefly for the updated token roles.`);
    }
    return { ...runner, principalId };
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
          setJobStatus(statusElement, `${label}: ${status.toLowerCase()}… Job ID: ${jobId}`, status.toLowerCase());
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
      return result;
    } finally {
      activeOperations.delete(operation);
      refreshControls();
    }
  }

  async function runOperation(payloadPath, operation, label, statusElement, parameters = {}) {
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
      const jobParameters = ["browserFailedSignIn", "browserFailedSignInThree"].includes(operation)
        ? { ...parameters, SubscriptionId: runner.subscriptionId, ResourceGroup: runner.resourceGroup }
        : parameters;
      setJobStatus(statusElement, `${label}: queued… Job ID: ${jobId}`, "queued");
      const { jobPath } = await automation.startJob({ requestJson: (path, options = {}) => arm(path, options), runner, payloadPath, jobId, parameters: jobParameters });
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

  async function markBaselineApplied(runner) {
    const marker = buildVersion("tenantBaselineVersion");
    const accountPath = automation.accountPath(runner.subscriptionId, runner.resourceGroup, runner.automationAccountName);
    await arm(`${accountPath}/providers/Microsoft.Resources/tags/default?api-version=${apiVersions.resources}`, {
      method: "PATCH",
      body: JSON.stringify({ operation: "Merge", properties: { tags: { "after-party-tenant-baseline-version": marker } } })
    });
    const updated = { ...runner, tenantBaselineVersion: marker };
    storeRunner(updated);
    return updated;
  }

  async function prepareTenantBaseline(lab, runner) {
    const operation = "seedTenant";
    if (activeOperations.has(operation)) throw new Error("Tenant preparation is already in progress.");
    activeOperations.add(operation);
    const statusElement = prerequisiteStatusElement;
    const jobId = crypto.randomUUID();
    try {
      setJobStatus(statusElement, `Tenant preparation: queued… Job ID: ${jobId}`, "queued");
      const { jobPath } = await automation.startJob({ requestJson: (path, options = {}) => arm(path, options), runner, payloadPath: "payloads/seed-tenant.ps1", jobId });
      const result = await pollJob(jobPath, statusElement, "Tenant preparation", jobId, operation);
      if (result.status !== "Completed") throw new Error(result.output || `Tenant preparation finished with status ${result.status}.`);
      return await markBaselineApplied(runner);
    } finally {
      activeOperations.delete(operation);
      refreshControls();
    }
  }

  async function restoreOrSelectEnvironment(lab) {
    if (el.subscription.value && el["resource-group"].value && currentRunner()) return;
    const stored = getStoredRunner();
    const previousSubscription = el.subscription.value;
    await loadSubscriptions(lab.operation, false);
    const subscriptionOptions = Array.from(el.subscription.options).filter(option => option.value);
    const resumedSubscription = subscriptionOptions.some(option => option.value === lab.form?.subscriptionId) ? lab.form.subscriptionId : "";
    const storedSubscription = stored?.tenantId === account.tenantId && subscriptionOptions.some(option => option.value === stored.subscriptionId) ? stored.subscriptionId : "";
    const currentSubscription = subscriptionOptions.some(option => option.value === previousSubscription) ? previousSubscription : "";
    el.subscription.value = resumedSubscription || storedSubscription || currentSubscription || (subscriptionOptions.length === 1 ? subscriptionOptions[0].value : "");
    if (!el.subscription.value) {
      if (!subscriptionOptions.length) throw new Error("No enabled Azure subscriptions are available to this account.");
      await chooseEnvironmentOption({
        type: "subscription",
        title: "Choose an Azure subscription",
        message: `${lab.label} will continue automatically after you choose where After Party should run.`
      });
    }
    const previousGroup = el["resource-group"].value;
    await loadResourceGroups(lab.operation, false);
    const groupOptions = Array.from(el["resource-group"].options).filter(option => option.value);
    const resumedGroup = groupOptions.some(option => option.value === lab.form?.resourceGroup) ? lab.form.resourceGroup : "";
    const storedGroup = stored?.tenantId === account.tenantId && stored.subscriptionId === el.subscription.value && groupOptions.some(option => option.value === stored.resourceGroup) ? stored.resourceGroup : "";
    const currentGroup = groupOptions.some(option => option.value === previousGroup) ? previousGroup : "";
    el["resource-group"].value = resumedGroup || storedGroup || currentGroup || (groupOptions.length === 1 ? groupOptions[0].value : "");
    if (!el["resource-group"].value) {
      if (!groupOptions.length) throw new Error("No Azure resource groups are available in this subscription.");
      await chooseEnvironmentOption({
        type: "resourceGroup",
        title: "Choose an Azure resource group",
        message: `${lab.label} will continue automatically after you choose the resource group for After Party.`
      });
    }
    setAccountSummary();
    setDiagnostics();
  }

  async function beginLab(operation, form) {
    const definition = labs[operation];
    if (!definition) throw new Error(`Unknown lab operation: ${operation}`);
    if (!(await frontendUpdateGate.check())) return;
    const lab = { ...definition, form };
    prerequisiteStatusElement = el[lab.statusId];
    setJobStatus(prerequisiteStatusElement, `${lab.label}: checking sign-in…`, "queued");
    setBusy(true);
    try {
      const result = await prerequisiteFlow.start(lab);
      if (result?.duplicate) setJobStatus(el[lab.statusId], `${lab.label} is already waiting or running.`);
    } catch (error) {
      if (error !== redirecting) {
        clearStatus();
        setJobStatus(el[lab.statusId], `${lab.label} could not start because its prerequisites did not complete.`, "error", explainError(error));
        if (error && typeof error === "object") error.afterPartyLabReported = true;
      }
      throw error;
    } finally {
      prerequisiteStatusElement = null;
      setBusy(false);
    }
  }

  async function signedIn(nextAccount) {
    account = nextAccount;
    msalClient.setActiveAccount(account);
    refreshControls();
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
    if (labs[pending.operation]) return await beginLab(pending.operation, pending.form);
    await restoreEnvironment(pending.form);
    switch (pending.operation) {
      case "loadSubscriptions":
      case "loadResourceGroups":
      case "discoverRunner":
        return;
      case "install":
        await installRunner();
        return;
      case "seedTenant":
        await prepareTenantBaseline({ operation: "seedTenant", label: "Tenant preparation" }, currentRunner());
        return;
    }
  }

  function configurePrerequisiteFlow() {
    if (!prerequisiteApi) throw new Error("prerequisite-flow.js is missing or did not load.");
    prerequisiteFlow = prerequisiteApi.createPrerequisiteFlow({
      isSignedIn: () => Boolean(account),
      signIn: async lab => {
        savePendingOperation(lab.operation);
        setStatus(`${lab.label} is waiting for sign-in. Redirecting to Microsoft…`);
        await msalClient.loginRedirect({ scopes: ["openid", "profile"] });
        throw redirecting;
      },
      ensureAuthorization: lab => token([ARM_SCOPE], lab.operation),
      restoreEnvironment: restoreOrSelectEnvironment,
      discoverRunner: lab => discoverRunner(lab.operation),
      installRunner: (lab, runner) => installRunner(lab.operation, runner, false),
      reconcilePermissions: reconcileRunnerPermissions,
      prepareBaseline: prepareTenantBaseline,
      startLab: lab => runOperation(lab.payloadPath, lab.operation, lab.label, el[lab.statusId], lab.parameters || {}),
      runnerVersion: () => buildVersion("runnerVersion"),
      tenantBaselineVersion: () => buildVersion("tenantBaselineVersion"),
      progress: message => {
        if (message === "Starting lab…") clearStatus();
        if (prerequisiteStatusElement) setJobStatus(prerequisiteStatusElement, message, "queued");
      },
      retryOptions: { attempts: 2 }
    });
  }

  async function initialize() {
    if (!config?.clientId) {
      el["configuration-warning"].hidden = false;
      el["configuration-warning"].textContent = "Set the Entra SPA application client ID in config.js before using this site.";
      setStatus("Configuration is incomplete.", "error");
      el["sign-in"].disabled = true;
      return;
    }
    if (!armRetry) throw new Error("arm-retry.js is missing or did not load.");
    if (!updateGateApi || !loadedDeployment?.commit) throw new Error("The loaded frontend commit is unavailable.");
    if (!window.msal) throw new Error("msal-browser.min.js is missing or did not load.");
    frontendUpdateGate = updateGateApi.createUpdateGate({
      loadedCommit: loadedDeployment.commit,
      getDeployedCommit: async () => (await fetchDeploymentInfo()).commit,
      promptForRefresh: promptForFrontendRefresh,
      refresh: () => window.location.replace(updateGateApi.cacheBustedUrl(window.location.href))
    });
    msalClient = new msal.PublicClientApplication({ auth: { clientId: config.clientId, authority: config.authority, redirectUri: config.redirectUri }, cache: { cacheLocation: "sessionStorage" } });
    if (typeof msalClient.initialize === "function") await msalClient.initialize();
    configurePrerequisiteFlow();
    refreshControls();
    const redirectResult = await msalClient.handleRedirectPromise();
    const cachedAccount = redirectResult?.account || msalClient.getAllAccounts()[0];
    if (cachedAccount) {
      await signedIn(cachedAccount);
      const pending = takePendingOperation();
      if (pending && redirectResult) await resumePendingOperation(pending);
      else clearStatus();
    } else {
      takePendingOperation();
      clearStatus();
    }
  }

  async function handleAction(action) {
    try { await action(); } catch (error) { if (error !== redirecting && !error?.afterPartyLabReported) setStatus(explainError(error), "error"); }
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
    el["account-menu"].open = false;
    return msalClient.logoutRedirect({ account });
  });
  document.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !el["account-menu"].open) return;
    event.preventDefault();
    el["account-menu"].open = false;
    el["account-button"].focus();
  });
  document.addEventListener("click", event => {
    if (el["account-menu"].open && !el["account-menu"].contains(event.target)) el["account-menu"].open = false;
  });
  bind("install", "click", () => handleAction(installRunner));
  bind("run", "click", () => handleAction(() => beginLab("sendEmail")));
  bind("run-file-share", "click", () => handleAction(() => beginLab("shareOneDriveFile")));
  bind("run-email-triage", "click", () => handleAction(() => beginLab("sendMessageBatch")));
  bind("run-customer-payment-export", "click", () => handleAction(() => beginLab("sendCustomerPaymentExport")));
  bind("run-external-email", "click", () => handleAction(() => beginLab("sendExternalEmail")));
  bind("run-failed-sign-in", "click", () => handleAction(() => beginLab("failedSignIn")));
  bind("run-failed-sign-in-three", "click", () => handleAction(() => beginLab("failedSignInThree")));
  bind("run-failed-sign-in-detection", "click", () => handleAction(() => beginLab("failedSignInDetection")));
  bind("run-browser-failed-sign-in", "click", () => handleAction(() => beginLab("browserFailedSignIn")));
  bind("run-browser-failed-sign-in-three", "click", () => handleAction(() => beginLab("browserFailedSignInThree")));
  bind("run-reset-lisa-password", "click", () => handleAction(() => beginLab("resetLisaPassword")));
  initialize().catch(error => setStatus(explainError(error), "error"));
})();
