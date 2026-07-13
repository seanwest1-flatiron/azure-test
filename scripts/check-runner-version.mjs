import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const RUNNER_AFFECTING_FILES = Object.freeze([
  "azuredeploy.json",
  "runbooks/bootstrap.ps1"
]);

export const RUNNER_APP_MARKERS = /APPLICATION_ROLES|GRAPH_SCOPES|grantApplicationPermissions|grantApplicationRole|installRunner|bootstrapUri|Microsoft\.Automation|Microsoft\.ContainerInstance/;

export function runnerAffectingFiles({ changedFiles, changedAppLines = [] }) {
  const files = changedFiles.filter(file => RUNNER_AFFECTING_FILES.includes(file));
  if (changedFiles.includes("app.js") && changedAppLines.some(line => RUNNER_APP_MARKERS.test(line))) files.push("app.js");
  return files;
}

export function validateRunnerVersionChange({ changedFiles, changedAppLines = [], previousManifest, currentManifest }) {
  const affectsRunner = runnerAffectingFiles({ changedFiles, changedAppLines });
  if (!affectsRunner.length || previousManifest.runnerVersion !== currentManifest.runnerVersion) return;
  throw new Error(`Runner-affecting files changed (${affectsRunner.join(", ")}) without changing version.json runnerVersion.`);
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function manifestAt(ref) {
  return JSON.parse(git("show", `${ref}:version.json`));
}

function changedAppLines(base) {
  return git("diff", "--unified=0", base, "HEAD", "--", "app.js")
    .split("\n")
    .filter(line => /^[+-](?![+-])/.test(line))
    .map(line => line.slice(1));
}

function main() {
  const requestedBase = process.argv[2] || process.env.GITHUB_EVENT_BEFORE;
  const base = requestedBase && !/^0+$/.test(requestedBase) ? requestedBase : "HEAD^";
  const changedFiles = git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean);
  validateRunnerVersionChange({
    changedFiles,
    changedAppLines: changedAppLines(base),
    previousManifest: manifestAt(base),
    currentManifest: JSON.parse(readFileSync("version.json", "utf8"))
  });
  console.log("Runner version guard passed.");
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) main();
