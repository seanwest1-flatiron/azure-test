Describe 'Failed sign-in custom detection payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/create-failed-sign-in-detection.ps1'
    }

    BeforeEach {
        $global:AfterPartyDetectionRule = $null
        $global:AfterPartyDetectionDefinition = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            displayName = 'Lisa Simpson repeated invalid-password sign-ins'
            description = 'Alerts on three AADSTS50126 invalid-password sign-ins for Lisa Simpson through the dedicated After Party sign-in application within one hour.'
            threshold = 3
            windowMinutes = 60
            frequency = 'PT1H'
            severity = 'medium'
            category = 'CredentialAccess'
        }
        $global:AfterPartyDetectionBaseline = [pscustomobject]@{
            failedSignInLab = [pscustomobject]@{ applicationDisplayName = 'After Party Failed Sign-In Generator'; userAlias = 'lisa.simpson' }
            users = @([pscustomobject]@{ userAlias = 'lisa.simpson'; displayName = 'Lisa Simpson' })
        }

        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Uri -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = 'payload-version' } }
            if ($Uri -like '*/payloads/tenant-seed.json?version=*') { return $global:AfterPartyDetectionBaseline }
            if ($Uri -like '*/payloads/failed-sign-in-detection.json?version=*') { return $global:AfterPartyDetectionDefinition }
            if ($Uri -like 'https://graph.microsoft.com/v1.0/applications?*' -and $Method -eq 'GET') {
                return [pscustomobject]@{ value = @([pscustomobject]@{ id = 'app-object-id'; appId = 'dedicated-app-id'; displayName = 'After Party Failed Sign-In Generator' }) }
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
    }

    It 'creates an enabled alert-only rule with tenant-relative Lisa, application, 50126, threshold, and window criteria' {
        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and
            $Method -eq 'POST' -and
            $Body -match '"status"\s*:\s*"enabled"' -and
            $Body -match 'lisa\.simpson@student\.onmicrosoft\.com' -and
            $Body -match 'dedicated-app-id' -and
            $Body -match 'ErrorCode == 50126' -and
            $Body -match 'FailureCount >= 3' -and
            $Body -match 'ago\(60m\)' -and
            $Body -match '"automatedActions"\s*:\s*\{\s*\}' -and
            $Body -notmatch 'responseActions|disableUser|resetPassword'
        }
        $global:AfterPartyDetectionRule.status | Should -Be 'enabled'
        $global:AfterPartyDetectionRule.detectionAction.psobject.Properties.Name | Should -Contain 'alertTemplate'
        @($global:AfterPartyDetectionRule.detectionAction.automatedActions.psobject.Properties).Count | Should -Be 0
        $global:AfterPartyDetectionRule.detectionAction.psobject.Properties.Name | Should -Not -Contain 'responseActions'
        ($output -join "`n") | Should -Match 'created and enabled for lisa\.simpson@student\.onmicrosoft\.com'
        ($output -join "`n") | Should -Match 'alert-only with no automated remediation'
    }

    It 'repairs and enables the existing rule without creating another rule' {
        $global:AfterPartyDetectionRule = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            status = 'disabled'
            queryCondition = [pscustomobject]@{ queryText = 'outdated query' }
            detectionAction = [pscustomobject]@{ automatedActions = [pscustomobject]@{ disableUsers = @([pscustomobject]@{ accountSidColumn = 'AccountSid' }) } }
        }

        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules/after-party-lisa-aadsts50126-three-in-one-hour' -and
            $Method -eq 'PATCH' -and
            $Body -match '"status"\s*:\s*"enabled"' -and
            $Body -match 'lisa\.simpson@school\.onmicrosoft\.com'
        }
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and $Method -eq 'POST'
        }
        @($global:AfterPartyDetectionRule.detectionAction.automatedActions.psobject.Properties).Count | Should -Be 0
        ($output -join "`n") | Should -Match 'repaired and enabled'
    }
}
