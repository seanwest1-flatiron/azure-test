Describe 'Lisa Simpson Temporary Access Pass sign-in payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/tap-sign-in.ps1'
        $tokenPayload = @{ tid = 'expected-tenant-id' } | ConvertTo-Json -Compress
        $encodedPayload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($tokenPayload)).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $graphAccessToken = "header.$encodedPayload.signature"
    }

    BeforeEach {
        $env:IDENTITY_ENDPOINT = 'http://identity.test/token'
        $env:IDENTITY_HEADER = 'identity-header'
        $global:AfterPartyTap = 'secret-tap-value'
        $global:AfterPartyTapBody = $null
        $global:AfterPartyTapContainerBody = $null
        $global:AfterPartyTapResult = 'confirmed'
        $global:AfterPartyExistingTapMethods = @()
        $global:AfterPartyTapCreationError = $false
        Mock Start-Sleep {}
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body, $StatusCodeVariable, $ResponseHeadersVariable)
            $uriText = [string]$Uri
            if ($uriText -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = 'tap-payload-version' } }
            if ($uriText -like '*/payloads/tenant-seed.json?version=*') {
                return [pscustomobject]@{
                    failedSignInLab = [pscustomobject]@{ applicationDisplayName = 'After Party Failed Sign-In Generator'; userAlias = 'lisa.simpson' }
                    users = @(
                        [pscustomobject]@{ userAlias = 'lisa.simpson'; displayName = 'Lisa Simpson' },
                        [pscustomobject]@{ userAlias = 'cory'; displayName = 'Cory West' }
                    )
                }
            }
            if ($uriText -eq 'https://graph.microsoft.com/v1.0/users/lisa.simpson%40student.onmicrosoft.com?$select=id,displayName,userPrincipalName') {
                return [pscustomobject]@{ id = 'lisa-id'; displayName = 'Lisa Simpson'; userPrincipalName = 'lisa.simpson@student.onmicrosoft.com' }
            }
            if ($uriText -like 'https://graph.microsoft.com/v1.0/applications?*') {
                return [pscustomobject]@{ value = @([pscustomobject]@{
                    appId = 'public-client-id'
                    displayName = 'After Party Failed Sign-In Generator'
                    isFallbackPublicClient = $true
                    publicClient = [pscustomobject]@{ redirectUris = @('http://localhost') }
                }) }
            }
            if ($Method -eq 'POST' -and $uriText -eq 'https://graph.microsoft.com/v1.0/users/lisa-id/authentication/temporaryAccessPassMethods') {
                $global:AfterPartyTapBody = [string]$Body
                if ($global:AfterPartyTapCreationError) {
                    Set-Variable -Name $StatusCodeVariable -Value 400 -Scope Global
                    Set-Variable -Name $ResponseHeadersVariable -Value @{ 'request-id' = 'graph-request-id'; Date = 'Mon, 13 Jul 2026 12:00:00 GMT' } -Scope Global
                    return [pscustomobject]@{ error = [pscustomobject]@{ code = 'invalidRequest'; message = 'The supplied TAP lifetime is outside the policy range.' } }
                }
                return [pscustomobject]@{ id = 'tap-method-id'; temporaryAccessPass = $global:AfterPartyTap }
            }
            if ($Method -eq 'GET' -and $uriText -eq 'https://graph.microsoft.com/v1.0/users/lisa-id/authentication/temporaryAccessPassMethods') {
                return [pscustomobject]@{ value = $global:AfterPartyExistingTapMethods }
            }
            if ($Method -eq 'DELETE' -and $uriText -eq 'https://graph.microsoft.com/v1.0/users/lisa-id/authentication/temporaryAccessPassMethods/tap-method-id') { return $null }
            if ($uriText -like 'http://identity.test/token?*') { return [pscustomobject]@{ access_token = 'arm-access-token' } }
            if ($uriText -eq 'https://management.azure.com/subscriptions/subscription-id/resourcegroups/after-test?api-version=2021-04-01') {
                return [pscustomobject]@{ location = 'eastus' }
            }
            if ($Method -eq 'PUT' -and $uriText -like 'https://management.azure.com/*/containerGroups/after-party-tap-*') {
                $global:AfterPartyTapContainerBody = [string]$Body
                return [pscustomobject]@{}
            }
            if ($Method -eq 'GET' -and $uriText -like 'https://management.azure.com/*/containerGroups/after-party-tap-*' -and $uriText -notlike '*/logs?*') {
                return [pscustomobject]@{ properties = [pscustomobject]@{ containers = @([pscustomobject]@{ properties = [pscustomobject]@{ instanceView = [pscustomobject]@{ currentState = [pscustomobject]@{ state = 'Terminated' } } } }) } }
            }
            if ($Method -eq 'GET' -and $uriText -like '*/containers/tap-browser-worker/logs?*') {
                if ($global:AfterPartyTapResult -eq 'registration_interrupted') {
                    return [pscustomobject]@{ content = 'TAP_SIGN_IN_RESULT {"result":"registration_interrupted","upn":"lisa.simpson@student.onmicrosoft.com","message":"Registration required."}' }
                }
                return [pscustomobject]@{ content = 'TAP_SIGN_IN_RESULT {"result":"confirmed","displayName":"Lisa Simpson","upn":"lisa.simpson@student.onmicrosoft.com","tenantId":"expected-tenant-id"}' }
            }
            if ($Method -eq 'DELETE' -and $uriText -like 'https://management.azure.com/*/containerGroups/after-party-tap-*') { return $null }
            throw "Unexpected REST request: $Method $uriText"
        }
    }

    It 'omits lifetime so the policy-compliant 60-minute tenant default applies and passes the TAP only as an ACI secure value' {
        $output = & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'

        $tapPolicy = [pscustomobject]@{ minimumLifetimeInMinutes = 60; defaultLifetimeInMinutes = 60; maximumLifetimeInMinutes = 480 }
        $tapPolicy.defaultLifetimeInMinutes | Should -BeGreaterOrEqual $tapPolicy.minimumLifetimeInMinutes
        $tapPolicy.defaultLifetimeInMinutes | Should -BeLessOrEqual $tapPolicy.maximumLifetimeInMinutes
        $global:AfterPartyTapBody | Should -Not -Match '"lifetimeInMinutes"'
        $global:AfterPartyTapBody | Should -Match '"isUsableOnce"\s*:\s*true'
        $container = $global:AfterPartyTapContainerBody | ConvertFrom-Json
        $environment = @($container.properties.containers[0].properties.environmentVariables)
        ($environment | Where-Object name -eq 'TENANT_DOMAIN').value | Should -Be 'student.onmicrosoft.com'
        ($environment | Where-Object name -eq 'USER_ALIAS').value | Should -Be 'lisa.simpson'
        ($environment | Where-Object name -eq 'TEMPORARY_ACCESS_PASS').secureValue | Should -Be $global:AfterPartyTap
        ($environment | Where-Object name -eq 'TEMPORARY_ACCESS_PASS').PSObject.Properties.Name | Should -Not -Contain 'value'
        ($output -join "`n") | Should -Be 'Lisa Simpson signed in with a Temporary Access Pass and Microsoft Graph /me confirmed her delegated identity. Cleanup completed.'
        ($output -join "`n") | Should -Not -Match [regex]::Escape($global:AfterPartyTap)
    }

    It 'deletes both the TAP and temporary container when security registration interrupts sign-in' {
        $global:AfterPartyTapResult = 'registration_interrupted'

        { & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test' } |
            Should -Throw '*security-information or MFA registration*'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'DELETE' -and ([string]$Uri) -match '/temporaryAccessPassMethods/tap-method-id$' }
        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter { $Method -eq 'DELETE' -and ([string]$Uri) -match '/containerGroups/after-party-tap-' }
    }

    It 'does not replace or expose a pre-existing Lisa TAP method' {
        $global:AfterPartyExistingTapMethods = @([pscustomobject]@{ id = 'existing-tap'; temporaryAccessPass = $null })

        { & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test' } |
            Should -Throw '*already has a Temporary Access Pass method*'

        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -eq 'POST' -and ([string]$Uri) -match '/temporaryAccessPassMethods$' }
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { ([string]$Uri) -match 'Microsoft.ContainerInstance/containerGroups' }
    }

    It 'surfaces the real Graph error body and response metadata without exposing the access token' {
        $global:AfterPartyTapCreationError = $true

        $message = $null
        try {
            & $payloadPath -GraphAccessToken $graphAccessToken -TenantDomain 'student.onmicrosoft.com' -SubscriptionId 'subscription-id' -ResourceGroup 'after-test'
        } catch { $message = $_.Exception.Message }

        $message | Should -Match 'HTTP 400; code: invalidRequest; message: The supplied TAP lifetime is outside the policy range\.'
        $message | Should -Match 'response body: .*"code":"invalidRequest"'
        $message | Should -Match 'request-id: graph-request-id; date: Mon, 13 Jul 2026 12:00:00 GMT'
        $message | Should -Not -Match [regex]::Escape($graphAccessToken)
    }
}
