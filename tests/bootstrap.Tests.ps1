Describe 'After Party bootstrap payload URL' {
    BeforeAll {
        $bootstrapPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'runbooks/bootstrap.ps1'
    }

    BeforeEach {
        $global:AfterPartyDownloadUri = $null
        Mock Invoke-RestMethod {
            param($Uri)
            if ($Uri -like '*/version.json?nonce=*') {
                return [pscustomobject]@{ runnerVersion = '2026.07.12.1'; payloadVersion = '2026.07.12.1' }
            }
            if ($Uri -like '*api-version=2019-08-01') {
                return [pscustomobject]@{ access_token = 'not-a-real-token' }
            }
            throw "Unexpected REST request: $Uri"
        }
        Mock Invoke-WebRequest {
            param($Uri)
            $global:AfterPartyDownloadUri = [string]$Uri
            return [pscustomobject]@{ Content = 'param([string] $GraphAccessToken)' }
        }
    }

    It 'keeps the lab path before the version query string and logs the full URL' {
        $output = & $bootstrapPath -LabPath 'payloads/seed-tenant.ps1'
        $expected = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main/payloads/seed-tenant.ps1?version=2026.07.12.1'

        $global:AfterPartyDownloadUri | Should -Be $expected
        ($output -contains "Resolved payload URL: $expected") | Should -Be $true
    }
}
