Describe 'Tenant seed license SKU matching' {
    BeforeAll {
        $seedScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/seed-tenant.ps1'
        $tokenPayload = @{ roles = @('GroupSettings.ReadWrite.All', 'LicenseAssignment.Read.All', 'LicenseAssignment.ReadWrite.All') } | ConvertTo-Json -Compress
        $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tokenPayload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $graphAccessToken = "header.$encodedPayload.signature"
    }

    BeforeEach {
        $global:AfterPartyGraphFailure = $false
        $global:AfterPartyTestSeed = [pscustomobject]@{
            licenses = [pscustomobject]@{
                businessPremium = [pscustomobject]@{ displayName = 'Microsoft 365 Business Premium'; skuPartNumberCandidates = @('SPB', 'O365_BUSINESS_PREMIUM') }
                combinedDefenderAndPurview = [pscustomobject]@{ displayName = 'Microsoft Defender and Purview Suites for Business Premium'; skuPartNumberCandidates = @('DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW', 'DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM') }
                defender = [pscustomobject]@{ displayName = 'Microsoft Defender for Business'; skuPartNumberCandidates = @('DEFENDER_BUSINESS') }
                purview = [pscustomobject]@{ displayName = 'Microsoft Purview Suite'; skuPartNumberCandidates = @('PURVIEW_SUITE') }
            }
            licensingGroup = [pscustomobject]@{ displayName = 'All Employees'; legacyDisplayNames = @(); mailNickname = 'all-employees' }
            passwordRuleSettings = [pscustomobject]@{ templateId = '5cf42378-d67d-4f36-ba46-e8b86229381d'; values = [pscustomobject]@{ LockoutThreshold = '100'; LockoutDurationInSeconds = '60' } }
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
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groupSettings/password-rule-id' -and $Method -eq 'GET') { return [pscustomobject]@{ values = @([pscustomobject]@{ name = 'LockoutThreshold'; value = '100' }, [pscustomobject]@{ name = 'LockoutDurationInSeconds'; value = '60' }, [pscustomobject]@{ name = 'UnrelatedSetting'; value = 'preserve-me' }) } }
            if (([Uri]$Uri).AbsolutePath -eq '/v1.0/groups') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'group-id'; displayName = 'All Employees'; mailNickname = 'all-employees'; groupTypes = @(); assignedLicenses = @() }) }
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense') {
                return [pscustomobject]@{}
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/groups/group-id/members?*') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'socky-id' }) }
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/users/socky*' -and $Method -eq 'GET') { return [pscustomobject]@{ id = 'socky-id'; userPrincipalName = 'socky@corywest.onmicrosoft.com' } }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/users/socky-id' -and $Method -eq 'PATCH') { return [pscustomobject]@{} }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/members/$ref' -and $Method -eq 'POST') { return [pscustomobject]@{} }
            throw "Unexpected REST request: $Method $Uri"
        }
        Mock Start-Sleep { }
    }

    It 'selects SPB and the current combined Defender and Purview suite SKU' {
        $output = & $seedScriptPath -GraphAccessToken $graphAccessToken

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense' -and
            $Body -match 'business-premium-id' -and
            $Body -match 'combined-suite-id' -and
            $Body -notmatch 'defender-id|purview-id'
        }
        ($output -match 'Managed identity Graph roles: .*GroupSettings.ReadWrite.All.*LicenseAssignment.Read.All.*LicenseAssignment.ReadWrite.All') | Should -Be $true
        ($output -contains 'Using combined Defender and Purview license SKU.') | Should -Be $true
    }

    It 'preserves unrelated Password Rule Settings values and verifies the lab lockout baseline' {
        $output = & $seedScriptPath -GraphAccessToken $graphAccessToken

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/groupSettings/password-rule-id' -and $Method -eq 'PATCH' -and
            $Body -match 'LockoutThreshold' -and $Body -match '"100"' -and $Body -match 'LockoutDurationInSeconds' -and $Body -match '"60"' -and $Body -match 'UnrelatedSetting' -and $Body -match 'preserve-me'
        }
        ($output -match 'Password Rule Settings verified: LockoutThreshold=100, LockoutDurationInSeconds=60') | Should -Be $true
    }

    It 'reports the method, endpoint, status, Graph code, and Graph message' {
        $global:AfterPartyGraphFailure = $true

        { & $seedScriptPath -GraphAccessToken $graphAccessToken } | Should -Throw '*GET https://graph.microsoft.com/v1.0/subscribedSkus; HTTP 403; code: Authorization_RequestDenied; message: Insufficient privileges to complete the operation.*'
    }

    It 'omits an empty optional surname when updating a user' {
        $global:AfterPartyTestSeed.users = @([pscustomobject]@{
            userPrincipalName = 'socky@corywest.onmicrosoft.com'
            displayName = 'Socky'
            givenName = 'Socky'
            surname = ''
            jobTitle = 'Systems Support Analyst'
            department = 'Corporate Services'
            mailNickname = 'socky'
        })

        & $seedScriptPath -GraphAccessToken $graphAccessToken

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/users/socky-id' -and
            $Method -eq 'PATCH' -and
            $Body -match '"displayName"\s*:\s*"Socky"' -and
            $Body -notmatch '"surname"'
        }
    }
}
