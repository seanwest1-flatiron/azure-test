Describe 'Tenant seed license SKU matching' {
    BeforeAll {
        $seedScriptPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/seed-tenant.ps1'
    }

    BeforeEach {
        $global:AfterPartyTestSeed = [pscustomobject]@{
            licenses = [pscustomobject]@{
                businessPremium = [pscustomobject]@{ displayName = 'Microsoft 365 Business Premium'; skuPartNumberCandidates = @('SPB', 'O365_BUSINESS_PREMIUM') }
                combinedDefenderAndPurview = [pscustomobject]@{ displayName = 'Microsoft Defender and Purview Suites for Business Premium'; skuPartNumberCandidates = @('DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW', 'DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM') }
                defender = [pscustomobject]@{ displayName = 'Microsoft Defender for Business'; skuPartNumberCandidates = @('DEFENDER_BUSINESS') }
                purview = [pscustomobject]@{ displayName = 'Microsoft Purview Suite'; skuPartNumberCandidates = @('PURVIEW_SUITE') }
            }
            group = [pscustomobject]@{ displayName = 'All Employees'; legacyDisplayNames = @(); mailNickname = 'all-employees' }
            users = @()
        }
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Uri -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = '2026.07.12.1' } }
            if ($Uri -like '*/payloads/tenant-seed.json?version=*') { return $global:AfterPartyTestSeed }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/subscribedSkus') {
                return [pscustomobject]@{ value = @(
                    [pscustomobject]@{ skuPartNumber = 'SPB'; skuId = 'business-premium-id' },
                    [pscustomobject]@{ skuPartNumber = 'DEFENDER_AND_PURVIEW_SUITES_FOR_BUSINESS_PREMIUM_NEW'; skuId = 'combined-suite-id' },
                    [pscustomobject]@{ skuPartNumber = 'DEFENDER_BUSINESS'; skuId = 'defender-id' },
                    [pscustomobject]@{ skuPartNumber = 'PURVIEW_SUITE'; skuId = 'purview-id' }
                ) }
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/groups?*') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'group-id'; displayName = 'All Employees'; assignedLicenses = @() }) }
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense') {
                return [pscustomobject]@{}
            }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/groups/group-id/members?*') { return [pscustomobject]@{ value = @() } }
            throw "Unexpected REST request: $Method $Uri"
        }
    }

    It 'selects SPB and the current combined Defender and Purview suite SKU' {
        $output = & $seedScriptPath -GraphAccessToken 'not-a-real-token'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/v1.0/groups/group-id/assignLicense' -and
            $Body -match 'business-premium-id' -and
            $Body -match 'combined-suite-id' -and
            $Body -notmatch 'defender-id|purview-id'
        }
        ($output -contains 'Using combined Defender and Purview license SKU.') | Should -Be $true
    }
}
