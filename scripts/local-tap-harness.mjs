import { X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

const GRAPH = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const domainPattern = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function defaultHarnessDirectory(environment = process.env) {
  return resolve(environment.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "after-party", "tap-harness");
}

export function defaultHarnessConfigPath(environment = process.env) {
  return resolve(defaultHarnessDirectory(environment), "config.json");
}

export function pathIsInside(parent, candidate) {
  const pathWithinParent = relative(resolve(parent), resolve(candidate));
  return pathWithinParent === "" || (!pathWithinParent.startsWith(`..${sep}`) && pathWithinParent !== ".." && !isAbsolute(pathWithinParent));
}

export function validateHarnessConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  for (const key of ["tenantId", "provisioningClientId", "signInClientId"]) {
    if (!uuidPattern.test(config[key] || "")) throw new Error(`Local TAP configuration '${key}' must be a Microsoft Entra GUID.`);
  }
  if (!domainPattern.test(config.tenantDomain || "")) throw new Error("Local TAP configuration 'tenantDomain' must be a DNS domain.");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(config.userAlias || "")) throw new Error("Local TAP configuration 'userAlias' is invalid.");
  if (config.expectedDisplayName !== "Lisa Simpson") throw new Error("Local TAP configuration must explicitly expect Lisa Simpson.");
  if (!isAbsolute(config.certificatePath || "")) throw new Error("Local TAP configuration 'certificatePath' must be absolute.");
  return Object.freeze({
    tenantId: config.tenantId,
    tenantDomain: config.tenantDomain,
    provisioningClientId: config.provisioningClientId,
    signInClientId: config.signInClientId,
    certificatePath: resolve(config.certificatePath),
    userAlias: config.userAlias,
    expectedDisplayName: config.expectedDisplayName
  });
}

async function assertPrivateFile(filePath, label) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) throw new Error(`${label} must not be readable or writable by group or other users: ${filePath}`);
}

export async function loadHarnessConfig({ configPath = defaultHarnessConfigPath(), repositoryRoot }) {
  const resolvedConfigPath = resolve(configPath);
  if (repositoryRoot && pathIsInside(repositoryRoot, resolvedConfigPath)) throw new Error("Local TAP configuration must be stored outside the repository.");
  await assertPrivateFile(resolvedConfigPath, "Local TAP configuration");
  const config = validateHarnessConfig(JSON.parse(await readFile(resolvedConfigPath, "utf8")));
  if (repositoryRoot && pathIsInside(repositoryRoot, config.certificatePath)) throw new Error("The local TAP certificate must be stored outside the repository.");
  await assertPrivateFile(config.certificatePath, "Local TAP certificate");
  const certificateSource = await readFile(config.certificatePath, "utf8");
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(certificateSource) || !/BEGIN CERTIFICATE/.test(certificateSource)) {
    throw new Error("The local TAP certificate PEM must contain both its private key and public certificate.");
  }
  const certificateBlock = certificateSource.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  const certificate = new X509Certificate(certificateBlock);
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error("The local TAP certificate has expired.");
  return Object.freeze({ configPath: resolvedConfigPath, config, certificate });
}

function graphErrorMessage(response, body, method, path) {
  return `Microsoft Graph ${method} ${path} failed: HTTP ${response.status}; ${body?.error?.code || "unknown_error"}: ${body?.error?.message || response.statusText || "Request failed."}`;
}

export async function graphRequest({ fetchImpl = fetch, accessToken, method = "GET", path, body }) {
  const response = await fetchImpl(`${GRAPH}${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let value = null;
  if (response.status !== 204) {
    const text = await response.text();
    if (text) {
      try { value = JSON.parse(text); } catch { value = null; }
    }
  }
  if (!response.ok) throw new Error(graphErrorMessage(response, value, method, path));
  return value;
}

export async function runWithManagedTemporaryAccessPass({
  config,
  credential,
  runSignIn,
  fetchImpl = fetch,
  logger = () => {},
  browserOptions = {},
  signal
}) {
  const upn = `${config.userAlias}@${config.tenantDomain}`;
  const encodedUpn = encodeURIComponent(upn);
  let accessToken;
  let tapId;
  let temporaryAccessPass;
  let result;
  let primaryError;
  let cleanupError;
  try {
    signal?.throwIfAborted();
    const token = await credential.getToken(GRAPH_SCOPE);
    if (!token?.token) throw new Error("The development app did not receive a Microsoft Graph app-only token.");
    accessToken = token.token;
    logger("graph-app-token", "acquired");

    const existing = await graphRequest({ fetchImpl, accessToken, path: `/users/${encodedUpn}/authentication/temporaryAccessPassMethods` });
    if ((existing?.value || []).length) throw new Error("Lisa Simpson already has a Temporary Access Pass method. The local harness did not replace or expose it.");
    logger("tap-preflight", "no-existing-method");

    const created = await graphRequest({
      fetchImpl,
      accessToken,
      method: "POST",
      path: `/users/${encodedUpn}/authentication/temporaryAccessPassMethods`,
      body: { isUsableOnce: true }
    });
    tapId = String(created?.id || "");
    temporaryAccessPass = String(created?.temporaryAccessPass || "");
    if (!tapId || !temporaryAccessPass) throw new Error("Microsoft Graph did not return a usable one-time Temporary Access Pass.");
    logger("tap", "created");
    signal?.throwIfAborted();

    result = await runSignIn({
      tenantId: config.tenantId,
      tenantDomain: config.tenantDomain,
      clientId: config.signInClientId,
      userAlias: config.userAlias,
      temporaryAccessPass,
      capturePageOnFailure: true,
      headless: true,
      maxPropagationAttempts: 3,
      ...browserOptions
    }, { signal });
    if (result?.result !== "confirmed" || result.displayName !== config.expectedDisplayName || String(result.upn || "").toLowerCase() !== upn.toLowerCase()) {
      throw new Error(`The shared TAP sign-in flow did not confirm ${config.expectedDisplayName}.`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    temporaryAccessPass = undefined;
    if (tapId && accessToken) {
      try {
        await graphRequest({
          fetchImpl,
          accessToken,
          method: "DELETE",
          path: `/users/${encodedUpn}/authentication/temporaryAccessPassMethods/${encodeURIComponent(tapId)}`
        });
        logger("tap", "deleted");
      } catch (error) {
        cleanupError = error;
      }
    }
    accessToken = undefined;
  }

  if (cleanupError) {
    const primary = primaryError ? ` Primary failure: ${primaryError.message}` : "";
    throw new Error(`Temporary Access Pass cleanup failed: ${cleanupError.message}.${primary}`);
  }
  if (primaryError) throw primaryError;
  return result;
}
