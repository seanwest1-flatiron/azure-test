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
- `automation-client.js`: shared Automation account discovery and job lifecycle logic
- `config.js`: public, non-secret SPA and repository settings
- `azuredeploy.json`: Automation account and bootstrap runbook deployment
- `runbooks/bootstrap.ps1`: stable runner installed into Automation
- `payloads/send-email.ps1`: replaceable email payload downloaded for every job
- `payloads/share-onedrive-file.ps1`: creates and shares a OneDrive text file
- `payloads/send-message-batch.ps1`: sends a message batch
- `payloads/send-customer-payment-export.ps1`: sends a customer payment export
- `payloads/send-external-email.ps1`: sends an external email
- `payloads/tenant-seed.json`: source of truth for baseline users, departments, groups, memberships, and licenses
- `payloads/seed-tenant.ps1`: prepares and validates the version-controlled tenant baseline
- `payloads/failed-sign-in.ps1`: records one expected invalid-credentials sign-in for a seeded non-admin user
- `payloads/browser-failed-sign-in.ps1`: starts one short-lived Playwright container worker for a browser sign-in failure
- `payloads/browser-failed-sign-in-worker.mjs`: browser worker downloaded by the short-lived container

Prepare tenant also maintains the After Party lab Password Rule Settings baseline (`LockoutThreshold` 100 and `LockoutDurationInSeconds` 60). These relaxed lockout values are intentional for controlled lab activity and are not a production security recommendation.

The failed-sign-in payload uses its own single-tenant public-client registration;
it does not enable public-client flows on the browser SPA registration.

The browser failed-sign-in operation uses Azure Container Instances for one
short-lived Playwright worker. Select **Update environment** once after this
release so the Automation identity receives the scoped Container Instances role.
- `version.json`: cache-busting site, runner, and payload release versions

## Tests and command-line job runner

Run the PowerShell and shared Automation client tests with:

```powershell
./tests/run-tests.ps1
```

The test runner requires Pester 5 or newer and Node.js 20 or newer.

With Azure CLI signed in, start an existing payload and print its complete
Automation output or error with:

```bash
node scripts/run-lab.mjs --subscription <subscription-id> --resource-group <resource-group> --lab payloads/send-email.ps1
```

The command discovers the existing After Party Automation account. Pass
`--automation-account <name>` only when the resource group contains more than
one candidate. It uses the same account discovery, job creation, polling, and
output collection implementation as the web application.

To have Purview apply a DLP action to the payment export, configure an Exchange
DLP policy for external recipients that detects the Credit Card Number sensitive
information type.
