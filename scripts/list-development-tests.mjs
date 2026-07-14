#!/usr/bin/env node

import { resolve } from "node:path";

export const developmentWorkflows = Object.freeze([
  { command: "npm run test:mocked", authentication: "offline", humanLogin: "never", purpose: "All PowerShell and JavaScript mocks" },
  { command: "npm run tap:check", authentication: "offline", humanLogin: "never", purpose: "TAP prerequisites and external certificate" },
  { command: "npm run arm:check -- --offline", authentication: "offline", humanLogin: "never", purpose: "ARM operator configuration and certificate" },
  { command: "npm run arm:check", authentication: "app-only ARM", humanLogin: "never", purpose: "Read-only token and RBAC validation" },
  { command: "npm run tap:local", authentication: "app-only Graph plus automated TAP", humanLogin: "never", purpose: "Fresh Playwright Lisa /me flow" },
  { command: "npm run lab:run -- --lab payloads/tap-sign-in.ps1", authentication: "app-only ARM", humanLogin: "never", purpose: "Automation and ACI live validation" },
  { command: "http://localhost:4173/ or the live site", authentication: "human delegated", humanLogin: "when testing product sign-in", purpose: "Frontend MSAL user experience" },
  { command: "Entra or Azure administration", authentication: "human administrator", humanLogin: "one-time or policy change", purpose: "App registration, consent, certificate, and RBAC changes" }
]);

export function renderWorkflowTable(workflows = developmentWorkflows) {
  const headers = ["Command", "Authentication", "Human login", "Purpose"];
  const rows = workflows.map(value => [value.command, value.authentication, value.humanLogin, value.purpose]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
  const format = row => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd();
  return [format(headers), format(widths.map(width => "-".repeat(width))), ...rows.map(format)].join("\n");
}

if (process.argv[1] && new URL(`file://${resolve(process.argv[1])}`).href === import.meta.url) {
  console.log(renderWorkflowTable());
  console.log("\nAutomated commands never fall back to interactive authentication.");
}
