# Development tenant configuration record

This page records the one-time cloud configuration used for After Party development. It is intentionally separate from workstation installation and external credential configuration. The resources below belong only in the dedicated development tenant; they are not requirements or universal values for student tenants.

The current development environment is `corywest.onmicrosoft.com`. The detailed creation and local configuration procedure is in [Local frontend and TAP sign-in development](developer-setup.md).

## Tenant-side checklist

| Tenant resource | Purpose | Required configuration |
| --- | --- | --- |
| Frontend app registration referenced by `config.js` | Test the static frontend locally | Preserve its existing production redirect URIs and add only `http://localhost:4173/` as a **Single-page application** redirect URI. |
| `After Party Failed Sign-In Generator` | Run the shared local and ACI Playwright sign-in flow | Configure it as a public client with `http://localhost` under **Mobile and desktop applications**. Do not add port 4173 to this app. |
| `After Party Local TAP Harness` | Create and clean up Lisa's single-use TAP without an administrator login on each test | Single-tenant confidential app; public certificate only; no client secret or redirect URI. Grant only the Microsoft Graph **application** permission `UserAuthMethod-TAP.ReadWrite.All` and grant tenant-wide admin consent. |
| Temporary Access Pass authentication-method policy | Permit the harness-created TAP to be used | Keep the policy enabled and ensure Lisa is covered directly or through its targeted group. |
| `After Party Development ARM Test Operator` | Start and inspect approved Automation or ACI development tests without repeated administrator login | Separate single-tenant confidential app; public certificate only; no client secret, redirect URI, or Microsoft Graph permissions. Assign the Azure roles listed below. |

The ARM test operator has these narrowly scoped assignments in the current development subscription:

- `Reader` on resource group `after-test`.
- `Azure Container Instances Contributor Role` on resource group `after-test`.
- `Automation Operator` on Automation account `after-party-92563293-ub7v2` in `after-test`.

Only public certificates are uploaded to Entra. Private keys and the tenant, client, subscription, and resource-group configuration remain outside the repository under the developer's protected configuration directory. Rotate certificates before expiry. When either automation identity is retired, remove its certificate, app registration, permissions or RBAC assignments, and external private-key files.

Use `npm run tap:check` and `npm run arm:check` to verify that the corresponding external configuration, certificate, tenant access, and required permissions remain usable. These checks do not replace periodic review of tenant-wide admin consent and Azure role assignments.
