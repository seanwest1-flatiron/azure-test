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
        $global:AfterPartyLogRequestCount = 0
        $global:AfterPartyLogsNotReadyOnce = $false
        $global:AfterPartyBatch = $false
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            $uriText = [string]$Uri
            if ($uriText -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = '2026.07.12.10' } }
            if ($uriText -like '*/payloads/tenant-seed.json?version=*') {
                return [pscustomobject]@{
                    failedSignInLab = [pscustomobject]@{ applicationDisplayName = 'After Party Failed Sign-In Generator'; userAlias = 'lisa.simpson' }
                    users = @([pscustomobject]@{ userAlias = 'lisa.simpson' })
                }
            }
            if ($uriText -like 'https://graph.microsoft.com/v1.0/applications?*') { return [pscustomobject]@{ value = @([pscustomobject]@{ appId = 'browser-client-id'; displayName = 'After Party Failed Sign-In Generator' }) } }
            if ($uriText -like 'http://identity.test/token?*') { return [pscustomobject]@{ access_token = 'arm-token' } }
            if ($uriText -eq 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test?api-version=2021-04-01') { return [pscustomobject]@{ location = 'eastus' } }
            if ($Method -eq 'PUT' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') {
                $global:AfterPartyContainerRequest = $Body | ConvertFrom-Json
                return [pscustomobject]@{}
            }
            if ($Method -eq 'GET' -and $uriText -like '*/containers/browser-worker/logs?*') {
                $global:AfterPartyLogRequestCount += 1
                if ($global:AfterPartyLogsNotReadyOnce -and $global:AfterPartyLogRequestCount -eq 1) { throw [System.Exception]::new('ContainerGroupDeploymentNotReady') }
                if ($global:AfterPartyBatch) { return [pscustomobject]@{ content = 'BROWSER_SIGN_IN_RESULT {"upn":"lisa.simpson@student.onmicrosoft.com","timestampUtc":"2026-07-12T12:00:00Z","result":"attempts_submitted","diagnostic":{"workerOutboundIp":"203.0.113.10","attempts":[{"number":1},{"number":2},{"number":3}]}}' } }
                return [pscustomobject]@{ content = 'BROWSER_SIGN_IN_RESULT {"upn":"lisa.simpson@student.onmicrosoft.com","timestampUtc":"2026-07-12T12:00:00Z","result":"credentials_rejected","diagnostic":{"message":"Credentials rejected."}}' }
            }
            if ($uriText -like 'https://graph.microsoft.com/v1.0/auditLogs/signIns?*') { return [pscustomobject]@{ value = @([pscustomobject]@{ signInEventTypes = @('interactiveUser'); status = [pscustomobject]@{ errorCode = 50126 } }) } }
            if ($Method -eq 'GET' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') {
                return [pscustomobject]@{ properties = [pscustomobject]@{ containers = @([pscustomobject]@{ properties = [pscustomobject]@{ instanceView = [pscustomobject]@{ currentState = [pscustomobject]@{ state = 'Terminated' } } } }) } }
            }
            if ($Method -eq 'DELETE' -and $uriText -like 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test/providers/Microsoft.ContainerInstance/containerGroups/*') { return [pscustomobject]@{} }
            throw "Unexpected REST request: $Method $uriText"
        }
    }

    It 'starts one non-restarting browser container and deletes it after credential rejection' {
        $output = & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'

        $global:AfterPartyContainerRequest.properties.restartPolicy | Should -Be 'Never'
        $global:AfterPartyContainerRequest.location | Should -Be 'eastus'
        $global:AfterPartyContainerRequest.properties.containers[0].properties.image | Should -Be 'mcr.microsoft.com/playwright:v1.61.0-noble'
        ($output -match 'Browser failed sign-in confirmed for lisa.simpson@student.onmicrosoft.com') | Should -Be $true
        $environment = @($global:AfterPartyContainerRequest.properties.containers[0].properties.environmentVariables)
        ($environment | Where-Object name -eq 'TENANT_DOMAIN').value | Should -Be 'student.onmicrosoft.com'
        ($environment | Where-Object name -eq 'CLIENT_ID').value | Should -Be 'browser-client-id'
        ($environment | Where-Object name -eq 'USER_ALIAS').value | Should -Be 'lisa.simpson'
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'PUT' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'DELETE' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
    }

    It 'retries only the existing container logs request when ACI is briefly not ready' {
        $global:AfterPartyLogsNotReadyOnce = $true
        Mock Start-Sleep {}

        $output = & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'

        ($output -match 'Browser failed sign-in confirmed for lisa.simpson@student.onmicrosoft.com') | Should -Be $true
        $global:AfterPartyLogRequestCount | Should -Be 2
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'PUT' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
        Should -Invoke Invoke-RestMethod -Times 2 -ParameterFilter { $Method -eq 'GET' -and ([string]$Uri) -match '/containers/browser-worker/logs\?' }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'DELETE' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
    }

    It 'uses one container for three submitted browser sign-ins and treats delayed log verification as best effort' {
        $global:AfterPartyBatch = $true
        $output = & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test' -AttemptCount 3

        ($output -match 'Three browser failed sign-ins submitted.*Worker outbound IP: 203.0.113.10.*partially verified') | Should -Be $true
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'PUT' -and ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { ([string]$Uri) -like 'https://graph.microsoft.com/v1.0/auditLogs/signIns?*' }
    }
}
