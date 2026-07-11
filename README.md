# After Party Azure prototype

Static GitHub Pages prototype for installing and running cybersecurity labs in a
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
the Automation account's managed identity the Microsoft Graph `Mail.Send`
application role. A later button click creates an Automation job directly with
the ARM REST API. The installed bootstrap runbook downloads the selected script
under `labs/` from the `main` branch for each job, so ordinary lab changes do not
require runner reinstallation.

The initial lab sends from `kobe@corywest.onmicrosoft.com` to
`cory@corywest.onmicrosoft.com`.

## Security note

Microsoft Graph application `Mail.Send` is tenant-wide unless it is restricted
separately with Exchange Online Application RBAC. Limit it to dedicated lab
mailboxes before using this design outside an isolated training tenant.

## Files

- `index.html`, `styles.css`, `app.js`: static application
- `config.js`: public, non-secret SPA and repository settings
- `azuredeploy.json`: Automation account and bootstrap runbook deployment
- `runbooks/bootstrap.ps1`: stable runner installed into Automation
- `labs/send-email.ps1`: replaceable lab payload downloaded for every job
