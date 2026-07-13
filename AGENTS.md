# Working instructions

- Read [docs/project-overview.md](docs/project-overview.md) and inspect existing conventions before implementing. Make focused, complete changes and handle normal implementation decisions independently.
- Run relevant tests and checks. Fix clear, localized issues within scope.
- Commit and push completed work by default unless the prompt says otherwise. The normal GitHub Pages deployment triggered by pushing is expected.
- Do not independently run labs, initiate authentication attempts, deploy resources, modify a live Azure or Microsoft 365 tenant, or perform other live tenant validation unless explicitly requested.
- Stop only when required information is missing, an external limitation blocks completion, or proceeding risks a significant unintended change.
- Keep version responsibilities distinct: `runnerVersion` covers runner infrastructure, bootstrap, roles, and permissions; `payloadVersion` covers runtime payloads; `tenantBaselineVersion` covers the provisioned tenant baseline. Bump only affected versions.
- Product invariant: students use their own isolated tenants. `corywest.onmicrosoft.com` and its tenant, subscription, resource-group, and object IDs are development values, never universal constants. Portable operations must derive tenant values from the signed-in environment or explicit environment configuration.
- Do not reset West family account passwords without explicit authorization. Other seeded persona accounts may have their passwords changed as part of lab mechanics.
- “After Party” is permitted platform and tenant branding. Tenant-visible users, messages, files, incidents, and activity should look functionally real and should not be unnecessarily labeled as simulations, exercises, tests, or training.
