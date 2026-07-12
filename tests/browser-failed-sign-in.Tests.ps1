Describe 'Browser failed sign-in payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/browser-failed-sign-in.ps1'
        $tokenPayload = @{ tid = 'tenant-id' } | ConvertTo-Json -Compress
        $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tokenPayload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $graphAccessToken = "header.$encodedPayload.signature"
    }

    BeforeEach {
        $env:IDENTITY_ENDPOINT = 'http://identity.test/token'
        $env:IDENTITY_HEADER = 'identity-header'
        $global:AfterPartyContainerRequest = $null
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            $uriText = [string]$Uri
            if ($uriText -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = '2026.07.12.10' } }
            if ($uriText -like '*/payloads/tenant-seed.json?version=*') {
                return [pscustomobject]@{
                    failedSignInLab = [pscustomobject]@{ clientId = 'browser-client-id'; userPrincipalName = 'lisa.simpson@corywest.onmicrosoft.com' }
                    users = @([pscustomobject]@{ userPrincipalName = 'lisa.simpson@corywest.onmicrosoft.com' })
                }
            }
            if ($uriText -like 'http://identity.test/token?*') { return [pscustomobject]@{ access_token = 'arm-token' } }
            if ($uriText -eq 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test?api-version=2021-04-01') { return [pscustomobject]@{ location = 'eastus' } }
            if ($Method -eq 'PUT' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') {
                $global:AfterPartyContainerRequest = $Body | ConvertFrom-Json
                return [pscustomobject]@{}
            }
            if ($Method -eq 'GET' -and $uriText -like '*/containers/browser-worker/logs?*') {
                return [pscustomobject]@{ content = 'BROWSER_SIGN_IN_RESULT {"upn":"lisa.simpson@corywest.onmicrosoft.com","timestampUtc":"2026-07-12T12:00:00Z","result":"credentials_rejected","diagnostic":{"message":"Credentials rejected."}}' }
            }
            if ($Method -eq 'GET' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') {
                return [pscustomobject]@{ properties = [pscustomobject]@{ containers = @([pscustomobject]@{ properties = [pscustomobject]@{ instanceView = [pscustomobject]@{ currentState = [pscustomobject]@{ state = 'Terminated' } } } }) } }
            }
            if ($Method -eq 'DELETE' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') { return [pscustomobject]@{} }
            throw "Unexpected REST request: $Method $uriText"
        }
    }

    It 'starts one non-restarting browser container and deletes it after credential rejection' {
        $output = & $payloadPath -GraphAccessToken $graphAccessToken -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'

        $global:AfterPartyContainerRequest.properties.restartPolicy | Should -Be 'Never'
        $global:AfterPartyContainerRequest.location | Should -Be 'eastus'
        $global:AfterPartyContainerRequest.properties.containers[0].properties.image | Should -Be 'mcr.microsoft.com/playwright:v1.61.0-noble'
        ($output -match 'Browser failed sign-in confirmed for lisa.simpson@corywest.onmicrosoft.com') | Should -Be $true
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'PUT' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'DELETE' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
    }
}
