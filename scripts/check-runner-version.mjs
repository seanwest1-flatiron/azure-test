import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const RUNNER_AFFECTING_FILES = Object.freeze([
  "azuredeploy.json",
  "runbooks/bootstrap.ps1"
]);

export function validateRunnerVersionChange({ changedFiles, previousManifest, currentManifest }) {
  const affectsRunner = changedFiles.some(file => RUNNER_AFFECTING_FILES.includes(file));
  if (!affectsRunner || previousManifest.runnerVersion !== currentManifest.runnerVersion) return;
  throw new Error(`Runner-affecting files changed (${changedFiles.filter(file => RUNNER_AFFECTING_FILES.includes(file)).join(", ")}) without changing version.json runnerVersion.`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function manifestAt(ref) {
  return JSON.parse(git("show", `${ref}:version.json`));
}

function main() {
  const requestedBase = process.argv[2] || process.env.GITHUB_EVENT_BEFORE;
  const base = requestedBase && !/^0+$/.test(requestedBase) ? requestedBase : "HEAD^";
  const changedFiles = git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  validateRunnerVersionChange({
    changedFiles,
    previousManifest: manifestAt(base),
    currentManifest: JSON.parse(readFileSync("version.json", "utf8"))
  });
  console.log("Runner version guard passed.");
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
