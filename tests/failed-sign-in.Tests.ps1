Describe 'Failed sign-in payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/failed-sign-in.ps1'
        $tokenPayload = @{ tid = 'tenant-id' } | ConvertTo-Json -Compress
        $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tokenPayload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $graphAccessToken = "header.$encodedPayload.signature"
    }

    BeforeEach {
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Uri -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = '2026.07.12.9' } }
            if ($Uri -like '*/payloads/tenant-seed.json?version=*') {
                return [pscustomobject]@{
                    failedSignInLab = [pscustomobject]@{ clientId = 'client-id'; userPrincipalName = 'lisa.simpson@corywest.onmicrosoft.com' }
                    users = @([pscustomobject]@{ userPrincipalName = 'lisa.simpson@corywest.onmicrosoft.com' })
                }
            }
            if ($Uri -eq 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token') {
                $record = [Management.Automation.ErrorRecord]::new(
                    [System.Exception]::new('Response status code does not indicate success: 400 (Bad Request).'),
                    'TokenRequestFailed',
                    [Management.Automation.ErrorCategory]::AuthenticationError,
                    $Uri
                )
                $record.ErrorDetails = [Management.Automation.ErrorDetails]::new('{"error":"invalid_grant","error_description":"AADSTS50126: Error validating credentials due to invalid username or password.","error_codes":[50126],"timestamp":"2026-07-12 12:00:00Z","correlation_id":"correlation-id"}')
                throw $record
            }
            throw "Unexpected REST request: $Method $Uri"
        }
    }

    It 'treats one invalid-credential response as a successful lab run' {
        $output = & $payloadPath -GraphAccessToken $graphAccessToken

        ($output -contains 'Failed sign-in recorded for lisa.simpson@corywest.onmicrosoft.com. Expected invalid-credentials response received: AADSTS50126.') | Should -Be $true
        ($output -contains 'Entra correlation ID: correlation-id') | Should -Be $true
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token' -and
            $Method -eq 'POST' -and
            $Body.username -eq 'lisa.simpson@corywest.onmicrosoft.com' -and
            $Body.password -match '^AfterParty-Invalid-' -and
            $Body.grant_type -eq 'password'
        }
    }
}
