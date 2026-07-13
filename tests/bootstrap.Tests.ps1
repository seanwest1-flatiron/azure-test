Describe 'After Party bootstrap payload URL' {
    BeforeAll {
        $bootstrapPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runbooks/bootstrap.ps1'
    }

    BeforeEach {
        $global:AfterPartyDownloadUri = $null
        $global:AfterPartyDomains = @(
            [pscustomobject]@{ id = 'student.example'; isDefault = $true; isInitial = $false; isVerified = $true },
            [pscustomobject]@{ id = 'student.onmicrosoft.com'; isDefault = $false; isInitial = $true; isVerified = $true }
        )
        Mock Invoke-RestMethod {
            param($Uri)
            if ($Uri -like '*/version.json?nonce=*') {
                return [pscustomobject]@{ runnerVersion = '2026.07.12.1'; payloadVersion = '2026.07.12.1' }
            }
            if ($Uri -like '*api-version=2019-08-01') {
                return [pscustomobject]@{ access_token = 'not-a-real-token' }
            }
            if ($Uri -eq 'https://graph.microsoft.com/v1.0/domains?$select=id,isDefault,isInitial,isVerified') {
                return [pscustomobject]@{ value = $global:AfterPartyDomains }
            }
            throw "Unexpected REST request: $Uri"
        }
        Mock Invoke-WebRequest {
            param($Uri)
            $global:AfterPartyDownloadUri = [string]$Uri
            return [pscustomobject]@{ Content = 'param([string] $GraphAccessToken, [string] $TenantDomain)' }
        }
    }

    It 'keeps the lab path before the version query string and logs the full URL' {
        $output = & $bootstrapPath -LabPath 'payloads/seed-tenant.ps1'
        $expected = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main/payloads/seed-tenant.ps1?version=2026.07.12.1'

        $global:AfterPartyDownloadUri | Should -Be $expected
        ($output -contains "Resolved payload URL: $expected") | Should -Be $true
    }

    It 'reports the version embedded in the installed bootstrap rather than the live manifest runner version' {
        $expectedRunnerVersion = (Get-Content (Join-Path (Split-Path -Parent $PSScriptRoot) 'version.json') -Raw | ConvertFrom-Json).runnerVersion
        $output = & $bootstrapPath -LabPath 'payloads/seed-tenant.ps1'

        ($output -contains "Installed runner version: $expectedRunnerVersion") | Should -Be $true
        ($output -contains 'Runner version: 2026.07.12.1') | Should -Be $false
    }

    It 'forwards the selected Azure context only to the browser worker payload' {
        Mock Invoke-WebRequest {
            param($Uri)
            return [pscustomobject]@{ Content = 'param([string] $GraphAccessToken, [string] $TenantDomain, [string] $SubscriptionId, [string] $ResourceGroup) "Worker context: $SubscriptionId/$ResourceGroup"' }
        }

        $output = & $bootstrapPath -LabPath 'payloads/browser-failed-sign-in.ps1' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'

        ($output -contains 'Worker context: subscription-id/after-test') | Should -Be $true
    }

    It 'forwards an explicit attempt count to the non-interactive failed sign-in payload' {
        Mock Invoke-WebRequest {
            param($Uri)
            return [pscustomobject]@{ Content = 'param([string] $GraphAccessToken, [string] $TenantDomain, [int] $AttemptCount) "Attempt count: $AttemptCount"' }
        }

        $output = & $bootstrapPath -LabPath 'payloads/failed-sign-in.ps1' -AttemptCount '3'

        ($output -contains 'Attempt count: 3') | Should -Be $true
    }

    It 'chooses the verified initial domain once and forwards it to the payload' {
        Mock Invoke-WebRequest {
            return [pscustomobject]@{ Content = 'param([string] $GraphAccessToken, [string] $TenantDomain) "Tenant domain: $TenantDomain"' }
        }

        $output = & $bootstrapPath -LabPath 'payloads/send-email.ps1'

        ($output -contains 'Resolved tenant domain: student.onmicrosoft.com') | Should -Be $true
        ($output -contains 'Tenant domain: student.onmicrosoft.com') | Should -Be $true
    }
}
