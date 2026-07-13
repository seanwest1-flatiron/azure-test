# Project overview

After Party is a cybersecurity lab platform where students investigate real activity through Microsoft security products. Each student connects an isolated Azure and Microsoft 365 tenant that they control. The platform must not assume that every installation uses the current development tenant, `corywest.onmicrosoft.com`.

## Architecture

The application is a static GitHub Pages frontend. It uses MSAL organizational sign-in to obtain delegated authorization for Microsoft Graph and Azure Resource Manager. The frontend installs and discovers an Azure Automation runner in the selected subscription and resource group.

The Automation account uses a system-assigned managed identity. Its stable bootstrap runbook obtains tenant-side tokens, resolves tenant context, and downloads versioned PowerShell payloads from this repository at runtime. Payloads perform the tenant operations used by labs and tenant preparation.

For portable identities, the bootstrap chooses the tenant's verified initial domain when available, then falls back to the verified default or another verified domain. It passes that single resolved value to tenant preparation and lab payloads, which combine it with aliases from the tenant seed.

## User experience

Students select meaningful labs rather than stepping through setup actions. The application signs in when needed, restores the selected Azure environment, discovers or updates the runner, prepares an outdated tenant baseline, and then starts the selected lab. Version markers keep these prerequisite checks inexpensive.

## Tenant activity and branding

The platform and tenant may openly use the After Party name. Activity created for investigation—users, messages, files, sign-ins, alerts, incidents, and other tenant-visible artifacts—should resemble functional organizational activity. It should not describe itself as a simulation, exercise, test, or training unless that wording comes naturally from the Microsoft product.

`corywest.onmicrosoft.com` is only the current development tenant. Tenant domains, tenant IDs, subscriptions, resource groups, and tenant object IDs must be resolved from the connected environment or supplied explicitly; they are not portable application constants.
