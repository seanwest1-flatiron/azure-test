#!/usr/bin/env node

import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { defaultArmOperatorConfigPath, defaultArmOperatorDirectory, pathIsInside, validateArmOperatorConfig } from "./development-arm-auth.mjs";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "..");

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--") || !values[index + 1] || values[index + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${name}`);
    options[name.slice(2)] = values[++index];
  }
  return options;
}

async function ensureExternalDirectory(directory) {
  const resolved = resolve(directory);
  if (pathIsInside(repositoryRoot, resolved)) throw new Error("ARM credentials and configuration must be created outside the repository.");
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(resolved, 0o700);
  return resolved;
}

async function refuseOverwrite(path) {
  await access(path).then(() => { throw new Error(`Refusing to overwrite existing file: ${path}`); }, error => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function generateCertificate(options) {
  const directory = await ensureExternalDirectory(options.directory || defaultArmOperatorDirectory());
  const credentialPath = resolve(directory, "credential.pem");
  const uploadPath = resolve(directory, "certificate.cer");
  const days = Number(options.days || 365);
  if (!Number.isInteger(days) || days < 1 || days > 730) throw new Error("--days must be an integer from 1 through 730.");
  await Promise.all([refuseOverwrite(credentialPath), refuseOverwrite(uploadPath)]);
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "after-party-arm-cert-"));
  const keyPath = resolve(temporaryDirectory, "key.pem");
  const certificatePath = resolve(temporaryDirectory, "certificate.pem");
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", String(days), "-subj", "/CN=After Party Development ARM Test Operator", "-keyout", keyPath, "-out", certificatePath]);
    await execute("openssl", ["x509", "-in", certificatePath, "-outform", "DER", "-out", uploadPath]);
    const credential = `${await readFile(keyPath, "utf8")}\n${await readFile(certificatePath, "utf8")}`;
    await writeFile(credentialPath, credential, { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") {
      await chmod(credentialPath, 0o600);
      await chmod(uploadPath, 0o600);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
  console.log(`Private credential (never upload): ${credentialPath}`);
  console.log(`Public certificate to upload: ${uploadPath}`);
}

async function writeConfiguration(options) {
  const configPath = resolve(options.config || defaultArmOperatorConfigPath());
  await ensureExternalDirectory(dirname(configPath));
  if (pathIsInside(repositoryRoot, configPath)) throw new Error("ARM test operator configuration must be outside the repository.");
  const config = validateArmOperatorConfig({
    tenantId: options["tenant-id"],
    clientId: options["client-id"],
    subscriptionId: options["subscription-id"],
    resourceGroup: options["resource-group"],
    certificatePath: resolve(options.certificate || resolve(defaultArmOperatorDirectory(), "credential.pem"))
  });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") await chmod(configPath, 0o600);
  console.log(`External ARM test operator configuration written to ${configPath}`);
}

export async function main(values = process.argv.slice(2)) {
  const [command, ...rest] = values;
  const options = parseOptions(rest);
  if (command === "certificate") await generateCertificate(options);
  else if (command === "configure") await writeConfiguration(options);
  else throw new Error("Usage: setup-development-arm-auth.mjs certificate [--directory PATH] [--days 365] | configure --tenant-id GUID --client-id GUID --subscription-id GUID --resource-group NAME [--certificate PATH] [--config PATH]");
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
