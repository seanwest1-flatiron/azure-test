"use strict";

((root, factory) => {
  const client = factory();
  if (typeof module === "object" && module.exports) module.exports = client;
  if (root) root.AfterPartyAutomation = client;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const API_VERSION = "2024-10-23";
  const TERMINAL_FAILURE_STATES = Object.freeze(["Failed", "Stopped", "Blocked", "Suspended", "Disconnected"]);

  function accountPath(subscriptionId, resourceGroup, automationAccountName) {
    return `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Automation/automationAccounts/${encodeURIComponent(automationAccountName)}`;
  }

  function automationAccountsPath(subscriptionId, resourceGroup) {
    return `/subscriptions/${encodeURIComponent(subscriptionId)}/resourcegroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Automation/automationAccounts`;
  }

  function jobState(status) {
    if (["New", "Activating", "Queued"].includes(status)) return "Queued";
    if (status === "Running") return "Running";
    if (status === "Completed") return "Completed";
    return status || "Queued";
  }

  async function findRunner({ requestJson, subscriptionId, resourceGroup, runbookName }) {
    const listPath = `${automationAccountsPath(subscriptionId, resourceGroup)}?api-version=${API_VERSION}`;
    const accounts = (await requestJson(listPath)).value || [];
    const candidates = accounts
      .filter(item => item.tags?.["after-party-runner"] === "true" || /^after-party-/i.test(item.name))
      .sort((left, right) => Number(right.tags?.["after-party-runner"] === "true") - Number(left.tags?.["after-party-runner"] === "true"));
    for (const candidate of candidates) {
      try {
        await requestJson(`${accountPath(subscriptionId, resourceGroup, candidate.name)}/runbooks/${encodeURIComponent(runbookName)}?api-version=${API_VERSION}`);
        return {
          subscriptionId,
          resourceGroup,
          automationAccountName: candidate.name,
          runbookName,
          runnerVersion: candidate.tags?.["after-party-runner-version"] || "unknown (update environment to record version)"
        };
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return null;
  }

  async function startJob({ requestJson, runner, payloadPath, jobId }) {
    const path = `${accountPath(runner.subscriptionId, runner.resourceGroup, runner.automationAccountName)}/jobs/${jobId}`;
    await requestJson(`${path}?api-version=${API_VERSION}`, {
      method: "PUT",
      body: JSON.stringify({ properties: { runbook: { name: runner.runbookName }, parameters: { LabPath: payloadPath } } })
    });
    return { jobId, jobPath: path };
  }

  async function getJobDetails({ requestJson, requestText, jobPath, job }) {
    const parts = [];
    try {
      const output = await requestText(`${jobPath}/output?api-version=${API_VERSION}`);
      if (output) parts.push(output);
    } catch { /* Job output is not always available after a failed job. */ }
    if (job.properties?.exception) parts.push(job.properties.exception);
    try {
      const streams = await requestJson(`${jobPath}/streams?api-version=${API_VERSION}`);
      const errors = (streams.value || [])
        .filter(stream => stream.properties?.streamType === "Error")
        .map(stream => stream.properties.streamText || stream.properties.summary || String(stream.properties.value || ""))
        .filter(Boolean);
      if (errors.length) parts.push(errors.join("\n"));
    } catch { /* The job status still supplies the primary failure message. */ }
    return [...new Set(parts)].join("\n");
  }

  async function waitForJob({ requestJson, requestText, jobPath, intervalMs = 1000, maxAttempts = 600, onStatus = () => {}, sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)) }) {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const job = await requestJson(`${jobPath}?api-version=${API_VERSION}`);
      const status = jobState(job.properties?.status);
      onStatus({ attempt, job, status });
      if (status === "Completed" || TERMINAL_FAILURE_STATES.includes(status)) {
        const output = await getJobDetails({ requestJson, requestText, jobPath, job });
        return { job, status, output };
      }
      await sleep(intervalMs);
    }
    return { status: "TimedOut", output: "" };
  }

  return Object.freeze({ API_VERSION, TERMINAL_FAILURE_STATES, accountPath, automationAccountsPath, findRunner, getJobDetails, jobState, startJob, waitForJob });
});
