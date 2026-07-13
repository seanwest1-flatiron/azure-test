#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClientCertificateCredential } from "@azure/identity";
import { chromium } from "playwright";
import { runTapSignIn } from "../payloads/tap-sign-in-worker.mjs";
import { defaultHarnessConfigPath, loadHarnessConfig, runWithManagedTemporaryAccessPass } from "./local-tap-harness.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

export function parseArguments(values) {
  const result = { configPath: defaultHarnessConfigPath(), headless: true };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--headed") result.headless = false;
    else if (value === "--config" && values[index + 1]) result.configPath = resolve(values[++index]);
    else throw new Error(`Unknown or incomplete argument: ${value}`);
  }
  return result;
}

async function useAvailableUserLocalBrowserLibraries() {
  if (process.platform !== "linux") return;
  const architecture = process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
  const directory = resolve(homedir(), ".local", "share", "after-party", "playwright-libs", "usr", "lib", architecture);
  try {
    await access(directory);
    process.env.LD_LIBRARY_PATH = [directory, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  } catch { /* The normal Playwright system dependency installation needs no override. */ }
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  await useAvailableUserLocalBrowserLibraries();
  const { config } = await loadHarnessConfig({ configPath: args.configPath, repositoryRoot });
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDirectory = resolve(repositoryRoot, ".artifacts", "tap-local", runId);
  await mkdir(artifactDirectory, { recursive: true });
  const checkpoints = [];
  const checkpoint = (stage, status) => {
    const entry = { stage, status, timestampUtc: new Date().toISOString() };
    checkpoints.push(entry);
    console.log(`[${stage}] ${status}`);
  };
  const reportDiagnostic = async ({ diagnostic, screenshot }) => {
    await writeFile(resolve(artifactDirectory, `${diagnostic.state}.json`), `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
    if (screenshot) await writeFile(resolve(artifactDirectory, `${diagnostic.state}.jpg`), screenshot, { mode: 0o600 });
  };

  const credential = new ClientCertificateCredential(config.tenantId, config.provisioningClientId, config.certificatePath);
  const abortController = new AbortController();
  let interruptCount = 0;
  const interrupt = () => {
    interruptCount += 1;
    if (interruptCount === 1) {
      console.error("Interrupt requested. Waiting for TAP and browser cleanup; press Ctrl+C again to force exit.");
      abortController.abort(new Error("The local TAP run was interrupted."));
    } else process.exit(130);
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const result = await runWithManagedTemporaryAccessPass({
      config,
      credential,
      fetchImpl: fetch,
      logger: checkpoint,
      signal: abortController.signal,
      browserOptions: { headless: args.headless },
      runSignIn: (configuration, { signal }) => runTapSignIn(configuration, { chromium, checkpoint, reportDiagnostic, signal })
    });
    console.log(`Confirmed ${result.displayName} through Microsoft Graph /me. TAP cleanup completed.`);
    console.log(`Sanitized diagnostics: ${artifactDirectory}`);
  } finally {
    await writeFile(resolve(artifactDirectory, "checkpoints.json"), `${JSON.stringify(checkpoints, null, 2)}\n`, { mode: 0o600 }).catch(error => {
      console.error(`Could not write sanitized checkpoints: ${error.message}`);
    });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
