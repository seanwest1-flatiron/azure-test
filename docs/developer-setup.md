# Local frontend and TAP sign-in development

This workflow separates fast local development from tenant validation:

- The dependency-free frontend server owns `http://localhost:4173/` and can stay running while files are edited.
- The TAP harness uses the same Playwright browser flow as the ACI worker. It creates an isolated, nonpersistent browser context for every attempt and intercepts its own `http://localhost` OAuth callback without opening a listener or using port 4173.
- A dedicated development-only confidential Entra application uses app-only Microsoft Graph access to create one single-use TAP for Lisa immediately before a run and delete only that TAP afterward. The existing `After Party Failed Sign-In Generator` public client performs the interactive sign-in and delegated `/me` request.

Do not use this workflow with a production tenant. The app-only TAP permission applies tenant-wide even though this harness is hard-coded to Lisa's tenant-relative alias and refuses to replace an existing TAP.

## Prerequisites

- Node.js 22 or newer and npm
- PowerShell 7 with Pester 5.5 or newer for the complete mocked suite
- OpenSSL
- A supported Playwright host; on Linux, installing browser system dependencies may require `sudo`
- Tenant roles sufficient to register an application, upload a certificate, add an application permission, grant tenant-wide admin consent, and view the Authentication methods policy. Depending on tenant policy, this normally involves an Application or Cloud Application Administrator plus a Privileged Role or Global Administrator for consent, and Authentication Policy Administrator if the TAP policy must be changed.

Install pinned development dependencies and Chromium:

```bash
npm ci
npx playwright install chromium
```

On a new Linux host, use `npx playwright install --with-deps chromium` if Playwright reports missing operating-system libraries.

Run the offline prerequisite check:

```bash
npm run tap:check -- --prerequisites-only
```

This check does not request a token or call Microsoft Graph.

## Local frontend

Start the frontend independently from the repository root:

```bash
node scripts/serve-local.mjs
```

Open `http://localhost:4173/`. Leave this process running while using the TAP harness in a second terminal. Stop only the frontend with `Ctrl+C` in its terminal. The frontend app registration's SPA redirect URI is `http://localhost:4173/`; it is unrelated to the public-client `http://localhost` callback used by the TAP harness.

## Mocked tests

Run all repository tests, including the mocked TAP create/sign-in/delete lifecycle:

```bash
npm run test:mocked
```

The lifecycle tests prove that a single-use TAP is requested, the shared browser worker receives it only in memory, cleanup runs after success or browser failure, an existing TAP is never replaced, and cleanup errors are surfaced. These tests do not authenticate or contact a tenant.

## One-time Entra configuration

Stop here until the tenant owner has reviewed and approved these changes. No client secret is used or stored.

1. Generate a development certificate outside the repository:

   ```bash
   npm run tap:setup -- certificate
   ```

   The command creates `~/.config/after-party/tap-harness/credential.pem` with mode `0600` and a public `certificate.cer`. Keep `credential.pem` private; upload only `certificate.cer`.

2. In the Microsoft Entra admin center, go to **Identity > Applications > App registrations > New registration**. Create a single-tenant app named `After Party Local TAP Harness`. Do not add a redirect URI.

3. In the new app registration, go to **Certificates & secrets > Certificates > Upload certificate** and upload `~/.config/after-party/tap-harness/certificate.cer`.

4. Go to **API permissions > Add a permission > Microsoft Graph > Application permissions**. Add only `UserAuthMethod-TAP.ReadWrite.All`, then select **Grant admin consent** and verify the status shows granted for the tenant. Do not add `User.Read.All`, a client secret, or delegated permissions to this confidential app.

5. Go to **Identity > Protection > Authentication methods > Policies > Temporary Access Pass**. Verify the policy is enabled and Lisa is included directly or through a targeted group. Preserve the existing scope; change it only if Lisa is not currently eligible.

6. Open the existing `After Party Failed Sign-In Generator` app registration. Record its Application (client) ID and verify **Authentication > Mobile and desktop applications** contains `http://localhost`. This is the same public-client registration used by ACI. Do not add port 4173 to this app.

7. Record the new confidential app's Application (client) ID, the tenant ID, and the tenant's verified domain. Write the external configuration:

   ```bash
   npm run tap:setup -- configure \
     --tenant-id TENANT_GUID \
     --tenant-domain TENANT_DOMAIN \
     --provisioning-client-id DEVELOPMENT_APP_CLIENT_GUID \
     --sign-in-client-id EXISTING_PUBLIC_CLIENT_GUID
   ```

   The configuration is written to `~/.config/after-party/tap-harness/config.json` with mode `0600`. Both the loader and setup command reject configuration or private certificate paths inside this repository.

8. Run the full offline setup check:

   ```bash
   npm run tap:check
   ```

The development certificate should be removed from the app registration and the external files deleted when this harness is no longer needed. Rotate it before its expiry rather than extending an old credential indefinitely.

## Local TAP test

This is a live tenant operation. Run it only after the one-time configuration and explicit approval:

```bash
npm run tap:local
```

Use `npm run tap:local -- --headless` only after the headed flow is stable. A run performs these checkpoints:

1. Obtain an app-only Graph token with the external certificate.
2. Confirm Lisa has no existing TAP; stop without changing it if one exists.
3. Create a single-use TAP and keep its value only in process memory.
4. Launch the shared Playwright flow in a fresh context. Account selection, consent, and the stay-signed-in prompt are optional states.
5. Capture the localhost authorization callback, exchange the PKCE code, and confirm Lisa through `/me`.
6. Close the browser and delete the TAP created by this run.

Press `Ctrl+C` once to request orderly browser and TAP cleanup. A second `Ctrl+C` forces exit and can leave the TAP behind. Sanitized diagnostics are written under `.artifacts/tap-local/`, which is ignored by Git.

If the process is killed, the host crashes, or cleanup reports an error, go to **Microsoft Entra admin center > Identity > Users > All users > Lisa Simpson > Authentication methods** and remove the temporary access pass created for the interrupted run. The harness will refuse another run while any TAP remains, and it never deletes a pre-existing TAP.

## Final ACI and live-site validation

After the local headed test passes:

1. Push the tested shared worker and allow the normal GitHub Pages deployment to complete.
2. Verify the live site's uncached deployment metadata reports the expected commit and payload version.
3. Start the relevant lab explicitly from the live site and inspect its Azure Automation and ACI result.
4. Confirm the ACI worker handles the same optional account-selection and consent states, receives a localhost callback, confirms Lisa through `/me`, and deletes its TAP and container group.

The local harness does not start a lab, deploy ACI, modify the frontend server, or validate the live site automatically.
