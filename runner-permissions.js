"use strict";

((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AfterPartyRunnerPermissions = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function requiredApplicationRoles(requiredRoleValues, graphPrincipal) {
    return requiredRoleValues.map(roleValue => {
      const role = graphPrincipal.appRoles?.find(candidate => candidate.value === roleValue && candidate.isEnabled && candidate.allowedMemberTypes?.includes("Application"));
      if (!role) throw new Error(`Microsoft Graph ${roleValue} application role was not found in this tenant.`);
      return role;
    });
  }

  function assignedRoleIds(assignments, graphPrincipalId) {
    return new Set((assignments.value || [])
      .filter(assignment => assignment.resourceId?.toLowerCase() === graphPrincipalId.toLowerCase())
      .map(assignment => assignment.appRoleId));
  }

  async function reconcileApplicationRoles({
    requiredRoleValues,
    graphPrincipal,
    getAssignments,
    assignRole,
    attempts = 15,
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    onWaiting = () => {}
  }) {
    const requiredRoles = requiredApplicationRoles(requiredRoleValues, graphPrincipal);
    const existingRoleIds = assignedRoleIds(await getAssignments(), graphPrincipal.id);
    const addedRoles = [];
    for (const role of requiredRoles) {
      if (existingRoleIds.has(role.id)) continue;
      await assignRole(role);
      addedRoles.push(role.value);
    }
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const verifiedRoleIds = assignedRoleIds(await getAssignments(), graphPrincipal.id);
      const missing = requiredRoles.filter(role => !verifiedRoleIds.has(role.id));
      if (!missing.length) return { addedRoles, requiredRoles: requiredRoles.map(role => role.value) };
      if (attempt === attempts) throw new Error(`The Automation managed identity is missing required Microsoft Graph application roles: ${missing.map(role => role.value).join(", ")}.`);
      onWaiting(missing);
      await sleep(2000);
    }
  }

  return Object.freeze({ assignedRoleIds, reconcileApplicationRoles, requiredApplicationRoles });
});
