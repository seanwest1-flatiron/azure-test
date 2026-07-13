# Tenant baseline reference

The provisioning source of truth is [`payloads/tenant-seed.json`](../payloads/tenant-seed.json). It stores tenant-independent aliases and baseline definitions. This document is only a human-readable reference; change the machine-readable seed when changing provisioning behavior.

## Expected licensing

- Microsoft 365 Business Premium — SKU part number `SPB`
- Combined Microsoft Defender and Purview Suites for Business Premium — SKU part number `DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW`

`All Employees` is the security group used for group-based licensing. Every baseline user is a member.

## Department groups and members

Department groups are Microsoft 365 groups. UPNs use the stable pattern `<alias>@<tenant-domain>`, where tenant preparation supplies one verified domain for the connected tenant.

| Department | Members |
| --- | --- |
| Executive | Cory West (`cory@<tenant-domain>`), Kobe West (`kobe@<tenant-domain>`) |
| IT | Socky West (`socky@<tenant-domain>`) |
| Corporate Services | Rocky West (`rocky@<tenant-domain>`) |
| Security | Homer Simpson (`homer.simpson@<tenant-domain>`), Marge Simpson (`marge.simpson@<tenant-domain>`), Lisa Simpson (`lisa.simpson@<tenant-domain>`), Bart Simpson (`bart.simpson@<tenant-domain>`) |
| Finance | Rachel Green (`rachel.green@<tenant-domain>`), Monica Geller (`monica.geller@<tenant-domain>`), Chandler Bing (`chandler.bing@<tenant-domain>`), Ross Geller (`ross.geller@<tenant-domain>`) |
| Human Resources | Jerry Seinfeld (`jerry.seinfeld@<tenant-domain>`), Elaine Benes (`elaine.benes@<tenant-domain>`), George Costanza (`george.costanza@<tenant-domain>`), Cosmo Kramer (`cosmo.kramer@<tenant-domain>`) |

## Account password policy

- Cory West, Kobe West, Rocky West, and Socky West are persistent accounts. Labs must not change their passwords unless explicitly requested.
- The other seeded persona accounts are disposable lab identities whose passwords may be reset by lab operations and should not be assumed stable.
