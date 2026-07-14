# After Party

After Party is a cybersecurity lab platform for investigating real Microsoft 365 and Azure activity with Microsoft security products. Each student connects an isolated Azure and Microsoft 365 tenant that they control, and the labs create real activity inside that tenant.

## Open After Party

**[Launch After Party](https://seanwest1-flatiron.github.io/azure-test/)**

Do not connect a production tenant. Use a dedicated tenant where lab-created users, messages, files, alerts, and configuration changes are safe and expected.

## Local frontend development

Run the dependency-free local server from the repository root:

```bash
node scripts/serve-local.mjs
```

Open `http://localhost:4173/`. The server disables browser caching, supplies local deployment metadata, and reloads the page when a root-level HTML, CSS, JavaScript, or JSON file changes. Press `Ctrl+C` in the terminal to stop it.

Viewing and editing the unauthenticated frontend requires no Azure configuration. Local Microsoft sign-in additionally requires `http://localhost:4173/` to be registered as a Single-page application redirect URI for the client ID in `config.js`. Starting the server does not authenticate or contact a tenant; selecting sign-in or a lab action can begin the real authorization and lab workflow.

## Documentation

- [Project overview](docs/project-overview.md) — product model, architecture, and user experience
- [Tenant baseline](docs/tenant-baseline.md) — expected licenses, users, groups, and memberships
- [Testing and live validation](docs/testing.md) — mocked tests and explicit authorization boundaries
- [Local frontend and TAP development](docs/developer-setup.md) — Playwright setup, app registration, mocked and live TAP workflows
- [Development tenant configuration](docs/development-tenant-configuration.md) — concise record of one-time Entra, TAP policy, redirect URI, and Azure RBAC changes
- `npm run test:list` — maintained inventory of offline, app-only, automated TAP, and intentionally human-authenticated workflows
- [Coding-agent instructions](AGENTS.md) — durable repository working conventions
