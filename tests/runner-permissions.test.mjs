import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { reconcileApplicationRoles } = require("../runner-permissions.js");

const graphPrincipal = {
  id: "graph-service-principal",
  appRoles: [
    { id: "domain-role", value: "Domain.Read.All", isEnabled: true, allowedMemberTypes: ["Application"] },
    { id: "application-role", value: "Application.ReadWrite.All", isEnabled: true, allowedMemberTypes: ["Application"] },
    { id: "password-profile-role", value: "User-PasswordProfile.ReadWrite.All", isEnabled: true, allowedMemberTypes: ["Application"] }
  ]
};

test("assigns a required role missing from an existing runner and verifies reconciliation", async () => {
  const assignments = [{ resourceId: graphPrincipal.id, appRoleId: "domain-role" }];
  const assigned = [];
  const result = await reconcileApplicationRoles({
    requiredRoleValues: ["Domain.Read.All", "Application.ReadWrite.All"],
    graphPrincipal,
    getAssignments: async () => ({ value: assignments }),
    assignRole: async role => {
      assigned.push(role.value);
      assignments.push({ resourceId: graphPrincipal.id, appRoleId: role.id });
    },
    sleep: async () => {}
  });

  assert.deepEqual(assigned, ["Application.ReadWrite.All"]);
  assert.deepEqual(result.addedRoles, ["Application.ReadWrite.All"]);
  assert.deepEqual(result.requiredRoles, ["Domain.Read.All", "Application.ReadWrite.All"]);
});

test("does not reassign roles already present on the runner", async () => {
  let assignments = 0;
  const result = await reconcileApplicationRoles({
    requiredRoleValues: ["Domain.Read.All"],
    graphPrincipal,
    getAssignments: async () => ({ value: [{ resourceId: graphPrincipal.id, appRoleId: "domain-role" }] }),
    assignRole: async () => { assignments += 1; },
    sleep: async () => {}
  });

  assert.equal(assignments, 0);
  assert.deepEqual(result.addedRoles, []);
});

test("reconciles the password-profile role for an existing runner", async () => {
  const assignments = [{ resourceId: graphPrincipal.id, appRoleId: "domain-role" }];
  const result = await reconcileApplicationRoles({
    requiredRoleValues: ["Domain.Read.All", "User-PasswordProfile.ReadWrite.All"],
    graphPrincipal,
    getAssignments: async () => ({ value: assignments }),
    assignRole: async role => assignments.push({ resourceId: graphPrincipal.id, appRoleId: role.id }),
    sleep: async () => {}
  });

  assert.deepEqual(result.addedRoles, ["User-PasswordProfile.ReadWrite.All"]);
});
