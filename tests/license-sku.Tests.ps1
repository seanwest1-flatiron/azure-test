Describe 'Tenant seed license SKU matching' {
    BeforeAll {
        $seedScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/seed-tenant.ps1'
        $tokenPayload = @{ roles = @('GroupSettings.ReadWrite.All', 'LicenseAssignment.Read.All', 'LicenseAssignment.ReadWrite.All') } | ConvertTo-Json -Compress
        $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tokenPayload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $graphAccessToken = "header.$encodedPayload.signature"
    }

    BeforeEach {
        $global:AfterPartyGraphFailure = $false
        $global:AfterPartyDetectionRule = $null
        $global:AfterPartyApplications = @()
        $global:AfterPartyServicePrincipals = @()
        $global:AfterPartyTestSeed = [pscustomobject]@{
            licenses = [pscustomobject]@{
                businessPremium = [pscustomobject]@{ displayName = 'Microsoft 365 Business Premium'; skuPartNumberCandidates = @('SPB', 'O365_BUSINESS_PREMIUM') }
                combinedDefenderAndPurview = [pscustomobject]@{ displayName = 'Microsoft Defender and Purview Suites for Business Premium'; skuPartNumberCandidates = @('DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW', 'DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM') }
                defender = [pscustomobject]@{ displayName = 'Microsoft Defender for Business'; skuPartNumberCandidates = @('DEFENDER_BUSINESS') }
                purview = [pscustomobject]@{ displayName = 'Microsoft Purview Suite'; skuPartNumberCandidates = @('PURVIEW_SUITE') }
            }
            licensingGroup = [pscustomobject]@{ displayName = 'All Employees'; legacyDisplayNames = @(); mailNickname = 'all-employees' }
            passwordRuleSettings = [pscustomobject]@{ templateId = '5cf42378-d67d-4f36-ba46-e8b86229381d'; values = [pscustomobject]@{ LockoutThreshold = '50'; LockoutDurationInSeconds = '60' } }
            failedSignInLab = $null
            customDetections = $null
            departments = @()
            users = @()
        }
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Uri -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = '2026.07.12.1' } }
            if ($Uri -like '*/payloads/tenant-seed.json?version=*') { return $global:AfterPartyTestSeed }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/subscribedSkus') {
                if ($global:AfterPartyGraphFailure) {
                    $record = [Management.Automation.ErrorRecord]::new(
                        [System.Exception]::new('Response status code does not indicate success: 403 (Forbidden).'),
                        'GraphRequestFailed',
                        [Management.Automation.ErrorCategory]::PermissionDenied,
                        $Uri
                    )
                    $record.ErrorDetails = [Management.Automation.ErrorDetails]::new('{"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}}')
                    throw $record
                }
                return [pscustomobject]@{ value = @(
                    [pscustomobject]@{ skuPartNumber = 'SPB'; skuId = 'business-premium-id' },
                    [pscustomobject]@{ skuPartNumber = 'DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW'; skuId = 'combined-suite-id' },
                    [pscustomobject]@{ skuPartNumber = 'DEFENDER_BUSINESS'; skuId = 'defender-id' },
                    [pscustomobject]@{ skuPartNumber = 'PURVIEW_SUITE'; skuId = 'purview-id' }
                ) }
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groupSettings') { return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'password-rule-id'; templateId = '5cf42378-d67d-4f36-ba46-e8b86229381d'; values = @([pscustomobject]@{ name = 'LockoutThreshold'; value = '10' }, [pscustomobject]@{ name = 'LockoutDurationInSeconds'; value = '30' }, [pscustomobject]@{ name = 'UnrelatedSetting'; value = 'preserve-me' }) }) } }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groupSettings/password-rule-id' -and $Method -eq 'PATCH') { return [pscustomobject]@{} }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groupSettings/password-rule-id' -and $Method -eq 'GET') { return [pscustomobject]@{ values = @([pscustomobject]@{ name = 'LockoutThreshold'; value = '50' }, [pscustomobject]@{ name = 'LockoutDurationInSeconds'; value = '60' }, [pscustomobject]@{ name = 'UnrelatedSetting'; value = 'preserve-me' }) } }
            if (([Uri]$Uri).AbsolutePath -eq '/v1.0/groups') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'group-id'; displayName = 'All Employees'; mailNickname = 'all-employees'; groupTypes = @(); assignedLicenses = @() }) }
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense') {
                return [pscustomobject]@{}
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/groups/group-id/members?*') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'socky-id' }) }
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/users/socky*' -and $Method -eq 'GET') { return [pscustomobject]@{ id = 'socky-id'; userPrincipalName = 'socky@student.onmicrosoft.com' } }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/users/socky-id' -and $Method -eq 'PATCH') { return [pscustomobject]@{} }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/members/$ref' -and $Method -eq 'POST') { return [pscustomobject]@{} }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/applications?*' -and $Method -eq 'GET') { return [pscustomobject]@{ value = $global:AfterPartyApplications } }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/applications' -and $Method -eq 'POST') {
                $properties = $Body | ConvertFrom-Json
                $application = [pscustomobject]@{ id = 'failed-app-object-id'; appId = 'dedicated-app-id'; displayName = $properties.displayName; isFallbackPublicClient = $properties.isFallbackPublicClient; signInAudience = $properties.signInAudience; publicClient = $properties.publicClient }
                $global:AfterPartyApplications = @($application)
                return $application
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/applications/failed-app-object-id' -and $Method -eq 'PATCH') { return [pscustomobject]@{} }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/servicePrincipals?*' -and $Method -eq 'GET') { return [pscustomobject]@{ value = $global:AfterPartyServicePrincipals } }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/servicePrincipals' -and $Method -eq 'POST') {
                $global:AfterPartyServicePrincipals = @([pscustomobject]@{ id = 'failed-sp-id'; appId = 'dedicated-app-id' })
                return $global:AfterPartyServicePrincipals[0]
            }
            if ($Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules/after-party-lisa-aadsts50126-three-in-one-hour') {
                if ($Method -eq 'GET' -and $null -ne $global:AfterPartyDetectionRule) { return $global:AfterPartyDetectionRule }
                if ($Method -eq 'GET') {
                    $exception = [System.Exception]::new('404 Not Found')
                    $exception.Data['StatusCode'] = 404
                    throw $exception
                }
                if ($Method -eq 'PATCH') {
                    $global:AfterPartyDetectionRule = $Body | ConvertFrom-Json
                    return [pscustomobject]@{}
                }
            }
            if ($Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and $Method -eq 'POST') {
                $global:AfterPartyDetectionRule = $Body | ConvertFrom-Json
                return $global:AfterPartyDetectionRule
            }
            throw "Unexpected REST request: $Method $Uri"
        }
        Mock Start-Sleep { }
    }

    It 'selects SPB and the current combined Defender and Purview suite SKU' {
        $output = & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense' -and
            $Body -match 'business-premium-id' -and
            $Body -match 'combined-suite-id' -and
            $Body -notmatch 'defender-id|purview-id'
        }
        ($output -match 'Managed identity Graph roles: .*GroupSettings.ReadWrite.All.*LicenseAssignment.Read.All.*LicenseAssignment.ReadWrite.All') | Should -Be $true
        ($output -contains 'Using combined Defender and Purview license SKU.') | Should -Be $true
    }

    It 'keeps Password Rule Settings automation inactive during tenant preparation' {
        $output = & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { ([string]$Uri) -match '/groupSettings' }
        ($output -join "`n") | Should -Not -Match 'Password Rule Settings'
    }

    It 'reports the method, endpoint, status, Graph code, and Graph message' {
        $global:AfterPartyGraphFailure = $true

        { & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' } | Should -Throw '*GET https://graph.microsoft.com/v1.0/subscribedSkus; HTTP 403; code: Authorization_RequestDenied; message: Insufficient privileges to complete the operation.*'
    }

    It 'omits an empty optional surname when updating a user' {
        $global:AfterPartyTestSeed.users = @([pscustomobject]@{
            userAlias = 'socky'
            displayName = 'Socky'
            givenName = 'Socky'
            surname = ''
            jobTitle = 'Systems Support Analyst'
            department = 'Corporate Services'
            mailNickname = 'socky'
        })

        & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/users/socky-id' -and
            $Method -eq 'PATCH' -and
            $Body -match '"displayName"\s*:\s*"Socky"' -and
            $Body -notmatch '"surname"'
        }
    }

    It 'reuses and repairs the dedicated tenant-local failed sign-in application' {
        $global:AfterPartyTestSeed.failedSignInLab = [pscustomobject]@{ applicationDisplayName = 'After Party Failed Sign-In Generator'; userAlias = 'lisa.simpson' }
        $global:AfterPartyApplications = @([pscustomobject]@{ id = 'failed-app-object-id'; appId = 'dedicated-app-id'; displayName = 'After Party Failed Sign-In Generator'; isFallbackPublicClient = $false; signInAudience = 'AzureADMyOrg'; publicClient = [pscustomobject]@{ redirectUris = @() } })
        $global:AfterPartyServicePrincipals = @([pscustomobject]@{ id = 'failed-sp-id'; appId = 'dedicated-app-id' })

        & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/applications/failed-app-object-id' -and $Method -eq 'PATCH' -and
            $Body -match '"isFallbackPublicClient"\s*:\s*true' -and $Body -match 'http://localhost'
        }
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Uri -eq 'https://graph.microsoft.com/v1.0/applications' -and $Method -eq 'POST' }
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Uri -eq 'https://graph.microsoft.com/v1.0/servicePrincipals' -and $Method -eq 'POST' }
    }

    It 'creates the Lisa invalid-password detection disabled with no automated response actions' {
        $global:AfterPartyTestSeed.customDetections = [pscustomobject]@{
            lisaFailedSignIns = [pscustomobject]@{
                id = 'after-party-lisa-aadsts50126-three-in-one-hour'
                displayName = 'Lisa Simpson repeated invalid-password sign-ins'
                description = 'Alerts on three AADSTS50126 invalid-password sign-ins for Lisa Simpson through the dedicated After Party sign-in application within one hour.'
                threshold = 3
                windowMinutes = 60
                frequency = 'PT1H'
                severity = 'medium'
                category = 'CredentialAccess'
            }
        }
        $global:AfterPartyTestSeed.failedSignInLab = [pscustomobject]@{ applicationDisplayName = 'After Party Failed Sign-In Generator'; userAlias = 'lisa.simpson' }

        $output = & $seedScriptPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and
            $Method -eq 'POST' -and
            $Body -match '"status"\s*:\s*"disabled"' -and
            $Body -match 'EntraIdSignInEvents' -and
            $Body -match 'ErrorCode == 50126' -and
            $Body -match 'FailureCount >= 3' -and
            $Body -match 'lisa\.simpson@student\.onmicrosoft\.com' -and
            $Body -match 'dedicated-app-id' -and
            $Body -notmatch 'responseActions'
        }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/applications' -and $Method -eq 'POST' -and
            $Body -match 'After Party Failed Sign-In Generator' -and
            $Body -match '"isFallbackPublicClient"\s*:\s*true' -and
            $Body -match 'http://localhost'
        }
        ($output -join "`n") | Should -Match 'Custom detection: after-party-lisa-aadsts50126-three-in-one-hour is disabled \(alert-only\)\.'
    }
}
