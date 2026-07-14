import { X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ClientCertificateCredential } from "@azure/identity";

export const ARM_ORIGIN = "https://management.azure.com";
export const ARM_SCOPE = `${ARM_ORIGIN}/.default`;
export const READER_ROLE_ID = "acdd72a7-3385-48ef-bd42-f606fba81ae7";
export const AUTOMATION_OPERATOR_ROLE_ID = "d3881f73-407a-4167-8283-e981cbba0404";
export const ACI_CONTRIBUTOR_ROLE_ID = "5d977122-f97e-4b4d-a52f-6b43003ddb4d";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const resourceGroupPattern = /^[a-zA-Z0-9._()/-]{1,90}$/;

export function defaultArmOperatorDirectory(environment = process.env) {
  return resolve(environment.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "after-party", "arm-test-operator");
}

export function defaultArmOperatorConfigPath(environment = process.env) {
  return resolve(defaultArmOperatorDirectory(environment), "config.json");
}

export function pathIsInside(parent, candidate) {
  const pathWithinParent = relative(resolve(parent), resolve(candidate));
  return pathWithinParent === "" || (!pathWithinParent.startsWith(`..${sep}`) && pathWithinParent !== ".." && !isAbsolute(pathWithinParent));
}

export function validateArmOperatorConfig(value) {
  const config = value && typeof value === "object" ? value : {};
  for (const key of ["tenantId", "clientId", "subscriptionId"]) {
    if (!uuidPattern.test(config[key] || "")) throw new Error(`ARM test operator configuration '${key}' must be a GUID.`);
  }
  if (!resourceGroupPattern.test(config.resourceGroup || "")) throw new Error("ARM test operator configuration 'resourceGroup' is invalid.");
  if (!isAbsolute(config.certificatePath || "")) throw new Error("ARM test operator configuration 'certificatePath' must be absolute.");
  return Object.freeze({
    tenantId: config.tenantId,
    clientId: config.clientId,
    subscriptionId: config.subscriptionId,
    resourceGroup: config.resourceGroup,
    certificatePath: resolve(config.certificatePath)
  });
}

async function assertPrivateFile(filePath, label) {
  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be readable or writable by group or other users: ${filePath}`);
  }
}

export async function loadArmOperatorConfig({ configPath = defaultArmOperatorConfigPath(), repositoryRoot } = {}) {
  const resolvedConfigPath = resolve(configPath);
  if (repositoryRoot && pathIsInside(repositoryRoot, resolvedConfigPath)) throw new Error("ARM test operator configuration must be stored outside the repository.");
  await assertPrivateFile(resolvedConfigPath, "ARM test operator configuration");
  const config = validateArmOperatorConfig(JSON.parse(await readFile(resolvedConfigPath, "utf8")));
  if (repositoryRoot && pathIsInside(repositoryRoot, config.certificatePath)) throw new Error("The ARM test operator certificate must be stored outside the repository.");
  await assertPrivateFile(config.certificatePath, "ARM test operator certificate");
  const certificateSource = await readFile(config.certificatePath, "utf8");
  if (!/BEGIN (?:RSA )?PRIVATE KEY/.test(certificateSource) || !/BEGIN CERTIFICATE/.test(certificateSource)) {
    throw new Error("The ARM test operator PEM must contain both its private key and public certificate.");
  }
  const certificateBlock = certificateSource.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
  const certificate = new X509Certificate(certificateBlock);
  if (Date.parse(certificate.validTo) <= Date.now()) throw new Error("The ARM test operator certificate has expired.");
  return Object.freeze({ configPath: resolvedConfigPath, config, certificate });
}

export function decodeJwtClaim(token, claim) {
  const segment = String(token || "").split(".")[1];
  if (!segment) throw new Error("The ARM access token was not a valid JWT.");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))[claim];
}

export function createDevelopmentArmClient({
  config,
  credential = new ClientCertificateCredential(config.tenantId, config.clientId, config.certificatePath),
  fetchImpl = fetch
}) {
  let confirmedToken;
  async function accessToken() {
    const token = await credential.getToken(ARM_SCOPE);
    if (!token?.token) throw new Error("The ARM test operator did not receive an app-only Azure management token.");
    const tokenTenant = String(decodeJwtClaim(token.token, "tid") || "");
    if (tokenTenant.toLowerCase() !== config.tenantId.toLowerCase()) throw new Error("The ARM test operator token belongs to an unexpected tenant.");
    const appId = String(decodeJwtClaim(token.token, "appid") || decodeJwtClaim(token.token, "azp") || "");
    if (appId.toLowerCase() !== config.clientId.toLowerCase()) throw new Error("The ARM test operator token belongs to an unexpected application.");
    confirmedToken = token;
    return token.token;
  }

  async function request(path, options = {}, textResponse = false) {
    const response = await fetchImpl(`${ARM_ORIGIN}${path}`, {
      ...options,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${await accessToken()}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    const text = await response.text();
    if (!response.ok) {
      let body;
      try { body = JSON.parse(text); } catch { body = null; }
      const error = new Error(body?.error?.message || text || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    if (textResponse) {
      try {
        const value = JSON.parse(text);
        return typeof value === "string" ? value : text;
      } catch { return text; }
    }
    return text ? JSON.parse(text) : null;
  }

  return Object.freeze({
    get accessTokenDetails() { return confirmedToken; },
    getToken: accessToken,
    request,
    requestJson: (path, options) => request(path, options),
    requestText: path => request(path, {}, true)
  });
}

export function roleDefinitionId(value) {
  return String(value || "").split("/").filter(Boolean).at(-1)?.toLowerCase() || "";
}
