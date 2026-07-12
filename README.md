# After Party Labs

Static GitHub Pages application for installing and running tenant operations in a
student-owned Microsoft Azure and Microsoft 365 tenant.

## Local configuration

1. Copy the multitenant Entra SPA application (client) ID into `config.js`.
2. Configure the SPA redirect URI as
   `https://seanwest1-flatiron.github.io/azure-test/`.
3. Add and admin-consent these delegated API permissions to the SPA:
   - Azure Service Management: `user_impersonation`
   - Microsoft Graph: `Application.Read.All`
   - Microsoft Graph: `AppRoleAssignment.ReadWrite.All`
4. The repository vendors the official `@azure/msal-browser` 4.30.0 LTS browser
   distribution as `msal-browser.min.js` (MIT license; version is in its header).

No secret belongs in this repository. The browser obtains delegated tokens for
the signed-in administrator. The installed Automation account uses its own
system-assigned managed identity at run time.

## Flow

The site deploys `azuredeploy.json` through Azure Resource Manager, then grants
the Automation account's managed identity the Microsoft Graph `Mail.Send` and
`Files.ReadWrite.All` application roles. A later button click creates an Automation job directly with
the ARM REST API. The installed bootstrap runbook downloads the selected script
under `payloads/` from the `main` branch for each job, so ordinary payload changes do not
require runner reinstallation.

`version.json` is the release manifest. On every page load, the browser fetches
it without using the cache and uses its site version for the application assets.
The bootstrap runbook uses its payload version for runtime files. Bump all three
versions when publishing a change; select **Update environment** only when the
bootstrap runbook or its permissions need to change. The Diagnostics section
shows the loaded site version, current runner version, and detected runner tag.

## GitHub Pages publishing

`.github/workflows/deploy-pages.yml` builds the static Pages artifact and writes
`deployment.json` into that artifact immediately before deployment. The browser
fetches that manifest with a unique cache-busting query value and displays the
commit and deployment time in Diagnostics, so those values describe the artifact
being served rather than the repository head.

In **Settings → Pages**, select **GitHub Actions** as the publishing source once.
The custom workflow then deploys every push to `main`.

The initial email operation sends from `kobe@corywest.onmicrosoft.com` to
`cory@corywest.onmicrosoft.com`.

## Security note

Microsoft Graph application `Mail.Send` is tenant-wide unless it is restricted
separately with Exchange Online Application RBAC. `Files.ReadWrite.All` can read
and write files across all site collections. Limit these permissions to an
isolated tenant before using this design elsewhere.

## Files

- `index.html`, `styles.css`, `app.js`: static application
- `config.js`: public, non-secret SPA and repository settings
- `azuredeploy.json`: Automation account and bootstrap runbook deployment
- `runbooks/bootstrap.ps1`: stable runner installed into Automation
- `payloads/send-email.ps1`: replaceable email payload downloaded for every job
- `payloads/share-onedrive-file.ps1`: creates and shares a OneDrive text file
- `payloads/send-message-batch.ps1`: sends a message batch
- `payloads/send-customer-payment-export.ps1`: sends a customer payment export
- `payloads/send-external-email.ps1`: sends an external email
- `payloads/tenant-seed.json`: source of truth for the tenant seed
- `payloads/seed-tenant.ps1`: creates or updates seeded users, membership, and licenses
- `version.json`: cache-busting site, runner, and payload release versions

To have Purview apply a DLP action to the payment export, configure an Exchange
DLP policy for external recipients that detects the Credit Card Number sensitive
information type.
