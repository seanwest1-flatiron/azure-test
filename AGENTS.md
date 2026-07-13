# Working instructions

- Inspect the repository and its existing conventions before choosing an implementation.
- Run relevant repository tests, checks, and validation before completing work.
- Commit and push completed work by default, unless the task explicitly says not to.
- Do not perform live tenant operations, deployments, authentication attempts, or other externally consequential actions unless the task explicitly calls for them.
- Keep version scopes separate: `runnerVersion` for runner infrastructure, bootstrap, roles, and permissions; `payloadVersion` for runtime payloads; and `tenantBaselineVersion` for tenant baseline changes. Bump only the versions affected by the change.
- “After Party” is permitted platform and tenant branding. Tenant-visible users, messages, files, incidents, and activity must look functionally real; do not call them simulations, exercises, tests, or training unless real Microsoft product wording does so.
