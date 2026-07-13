#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultHarnessConfigPath, loadHarnessConfig } from "./local-tap-harness.mjs";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");

function argumentsFrom(values) {
  const result = { configPath: defaultHarnessConfigPath(), prerequisitesOnly: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--prerequisites-only") result.prerequisitesOnly = true;
    else if (values[index] === "--config" && values[index + 1]) result.configPath = resolve(values[++index]);
    else throw new Error(`Unknown or incomplete argument: ${values[index]}`);
  }
  return result;
}

export async function checkPrerequisites({ resolvePackage = require.resolve, run = execute, fileAccess = access } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(`Node.js 22 or newer is required; found ${process.versions.node}.`);
  await run("openssl", ["version"]);
  resolvePackage("@azure/identity/package.json");
  resolvePackage("playwright/package.json");
  const { chromium } = await import("playwright");
  await fileAccess(chromium.executablePath());
  return "Node.js, OpenSSL, Azure Identity, Playwright, and Chromium are ready.";
}

export async function main(values = process.argv.slice(2)) {
  const options = argumentsFrom(values);
  console.log(await checkPrerequisites());
  if (!options.prerequisitesOnly) {
    const loaded = await loadHarnessConfig({ configPath: options.configPath, repositoryRoot });
    console.log(`External configuration and certificate are valid: ${loaded.configPath}`);
  }
  console.log("Offline setup check passed. No token was requested and Microsoft Graph was not called.");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(`Setup check failed: ${error.message}`);
  process.exitCode = 1;
});
