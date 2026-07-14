# Testing and live validation

The normal test suite is mocked and non-live. It must not authenticate to, query, or modify an Azure or Microsoft 365 tenant.

Run the complete mocked suite from the repository root:

```bash
pwsh ./tests/run-tests.ps1
```

## Local static site

Start the local frontend with:

```bash
node scripts/serve-local.mjs
```

Open `http://localhost:4173/`. The server uses only Node built-in modules. It serves every response with `Cache-Control: no-store`, creates an in-memory `deployment.json` for the site's deployment checks, and triggers a browser reload when a root-level HTML, CSS, JavaScript, or JSON file changes. It does not write generated files into the working tree. Stop it with `Ctrl+C`.

Run `npm run test:list` for the maintained authentication inventory. Automated mocked, TAP, Automation, and ACI development commands do not implicitly open an administrator browser. See [developer setup](developer-setup.md) for the separate app-only Graph and ARM identities and their one-time configuration.

The server binds to the loopback interface and does not expose developer-only `.git`, `.github`, `.artifacts`, `_site`, `scripts`, or `tests` paths. It does not mock the application's ARM or Graph requests: selecting sign-in or a lab action can enter the real tenant workflow.

Unauthenticated layout and frontend loading require no Azure configuration. To exercise MSAL redirects locally, add `http://localhost:4173/` to the existing app registration as a Single-page application redirect URI. `config.js` selects that URI only for the exact local origin and retains the GitHub Pages redirect everywhere else.

Live integration validation is separate from the normal suite and CI. Run it only when the current task explicitly authorizes live access, and verify the expected tenant before making any change.

Authorization to validate a configuration operation does not authorize generating security activity. Failed sign-ins and other security-activity generation require separate, explicit authorization.

The failed-sign-in custom-detection validator under `tests/live` requires `AFTER_PARTY_ALLOW_LIVE_TESTS=1`, an expected tenant domain and tenant ID, and the explicit desired state `enabled`. It inspects live state before deciding whether one state-aware mutation is needed; it is not part of the normal suite or CI.
