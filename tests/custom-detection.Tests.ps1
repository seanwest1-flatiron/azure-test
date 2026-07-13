Describe 'Failed sign-in custom detection payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/create-failed-sign-in-detection.ps1'
    }

    BeforeEach {
        $global:AfterPartyDetectionRule = $null
        $global:AfterPartyDetectionCreateError = $null
        $global:AfterPartyDetectionDefinition = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            displayName = 'Lisa Simpson repeated invalid-password sign-ins'
            description = 'Alerts on three AADSTS50126 invalid-password sign-ins for Lisa Simpson through the dedicated After Party sign-in application within any one-hour period, checking the preceding three hours for delayed ingestion.'
            threshold = 3
            windowMinutes = 60
            searchHorizonHours = 3
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
                    $patch = $Body | ConvertFrom-Json
                    foreach ($property in $patch.psobject.Properties) {
                        $global:AfterPartyDetectionRule | Add-Member -MemberType NoteProperty -Name $property.Name -Value $property.Value -Force
                    }
                    return $global:AfterPartyDetectionRule
                }
            }
            if ($Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and $Method -eq 'POST') {
                if ($null -ne $global:AfterPartyDetectionCreateError) { throw $global:AfterPartyDetectionCreateError }
                $global:AfterPartyDetectionRule = $Body | ConvertFrom-Json
                return $global:AfterPartyDetectionRule
            }
            throw "Unexpected REST request: $Method $Uri"
        }
    }

    It 'creates a missing rule enabled with a delayed-ingestion-tolerant, alert-only query' {
        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'student.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules' -and
            $Method -eq 'POST' -and
            $Body -match '"status"\s*:\s*"enabled"' -and
            $Body -match 'lisa\.simpson@student\.onmicrosoft\.com' -and
            $Body -match 'dedicated-app-id' -and
            $Body -match 'ErrorCode == 50126' -and
            $Body -match 'ago\(3h\)' -and
            $Body -match 'ClusterWindowStart \.\. ClusterWindowStart \+ 60m' -and
            $Body -match 'FailureCount >= 3' -and
            $Body -match 'arg_max\(Timestamp, ReportId\)' -and
            $Body -match 'sort by ClusterWindowEnd desc, ClusterWindowStart desc' -and
            $Body -match 'take 1' -and
            $Body -match 'project Timestamp, ReportId, AccountUpn, ApplicationId, FailureCount' -and
            $Body -match '"entityMappings"\s*:\s*\{' -and
            $Body -match '"accounts"\s*:\s*\[' -and
            $Body -match '"upnColumn"\s*:\s*"AccountUpn"' -and
            $Body -notmatch 'automatedActions|responseActions|disableUser|resetPassword'
        }
        $global:AfterPartyDetectionRule.status | Should -Be 'enabled'
        $global:AfterPartyDetectionRule.detectionAction.psobject.Properties.Name | Should -Not -Contain 'automatedActions'
        ($output -join "`n") | Should -Match 'created and enabled for lisa\.simpson@student\.onmicrosoft\.com'
        ($output -join "`n") | Should -Match 'normal immediate first evaluation'
    }

    It 'enables an existing disabled rule without an undocumented immediate-run request' {
        & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com' | Out-Null
        $global:AfterPartyDetectionRule.status = 'disabled'

        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules/after-party-lisa-aadsts50126-three-in-one-hour' -and
            $Method -eq 'PATCH' -and $Body -match '"status"\s*:\s*"enabled"'
        }
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Uri -match '/detectionRules/.+/(run|execute)' }
        $global:AfterPartyDetectionRule.status | Should -Be 'enabled'
        ($output -join "`n") | Should -Match 'enabled for lisa\.simpson@school\.onmicrosoft\.com'
        ($output -join "`n") | Should -Match 'hourly schedule'
        ($output -join "`n") | Should -Not -Match 'repaired and enabled'
    }

    It 'repairs and enables a disabled rule with stale query or remediation settings' {
        $global:AfterPartyDetectionRule = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            status = 'disabled'
            displayName = 'Lisa Simpson repeated invalid-password sign-ins'
            description = 'outdated description'
            queryCondition = [pscustomobject]@{ queryText = 'outdated query' }
            schedule = [pscustomobject]@{ frequency = 'PT1H' }
            detectionAction = [pscustomobject]@{
                alertTemplate = [pscustomobject]@{ entityMappings = [pscustomobject]@{ accounts = @() } }
                automatedActions = [pscustomobject]@{ disableUsers = @([pscustomobject]@{ accountSidColumn = 'AccountSid' }) }
            }
        }

        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com'

        $global:AfterPartyDetectionRule.status | Should -Be 'enabled'
        $global:AfterPartyDetectionRule.detectionAction.automatedActions | Should -BeNullOrEmpty
        $global:AfterPartyDetectionRule.detectionAction.responseActions | Should -BeNullOrEmpty
        $global:AfterPartyDetectionRule.detectionAction.alertTemplate.entityMappings.accounts[0].upnColumn | Should -Be 'AccountUpn'
        ($output -join "`n") | Should -Match 'repaired and enabled'
        ($output -join "`n") | Should -Match 'alert-only with no automated remediation'
    }

    It 'treats Graph-expanded empty action collections as alert-only when disabling an enabled rule' {
        $global:AfterPartyDetectionRule = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            status = 'enabled'
            detectionAction = [pscustomobject]@{
                automatedActions = [pscustomobject]@{
                    isolateDevices = @()
                    stopAndQuarantineFiles = @()
                    disableUsers = @()
                    forceUserPasswordResets = @()
                    markUsersAsCompromised = @()
                    runAntivirusScans = @()
                }
                responseActions = @()
            }
        }

        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 1 -ParameterFilter {
            $Uri -eq 'https://graph.microsoft.com/beta/security/rules/detectionRules/after-party-lisa-aadsts50126-three-in-one-hour' -and
            $Method -eq 'PATCH' -and $Body -match '"status"\s*:\s*"disabled"'
        }
        $global:AfterPartyDetectionRule.status | Should -Be 'disabled'
        ($output -join "`n") | Should -Match 'disabled\. The rule remains alert-only with no automated remediation'
    }

    It 'rejects an enabled rule whose expanded action collection contains a real nested action' {
        $global:AfterPartyDetectionRule = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            status = 'enabled'
            detectionAction = [pscustomobject]@{
                automatedActions = [pscustomobject]@{
                    isolateDevices = @()
                    disableUsers = @([pscustomobject]@{ accountSidColumn = 'AccountSid' })
                    forceUserPasswordResets = @()
                }
                responseActions = @()
            }
        }

        { & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com' } |
            Should -Throw "*Custom detection '$($global:AfterPartyDetectionDefinition.id)' unexpectedly contains a remediation action.*"
    }

    It 'leaves an auto-disabled rule unchanged and reports Defender last-run details' {
        $global:AfterPartyDetectionRule = [pscustomobject]@{
            id = 'after-party-lisa-aadsts50126-three-in-one-hour'
            status = 'autoDisabled'
            lastRunDetails = [pscustomobject]@{ lastRunDateTime = '2026-07-13T12:00:00Z'; status = 'failed'; errorCode = 'queryTimeout'; failureReason = 'The query timed out.' }
        }

        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'school.onmicrosoft.com'

        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter { $Method -in @('PATCH', 'POST') -and $Uri -match '/security/rules/detectionRules' }
        ($output -join "`n") | Should -Match 'auto-disabled by Defender and was left unchanged'
        ($output -join "`n") | Should -Match '2026-07-13T12:00:00Z'
        ($output -join "`n") | Should -Match 'queryTimeout'
    }

    It 'reports the Graph response code, message, request id, and response date without exposing the token' {
        $exception = [System.Exception]::new('400 Bad Request')
        $exception.Data['StatusCode'] = 400
        $exception.Data['GraphErrorBody'] = '{"error":{"code":"BadRequest","message":"Invalid automatedActions payload.","innerError":{"request-id":"request-123","date":"2026-07-13T13:00:00Z"}}}'
        $global:AfterPartyDetectionCreateError = $exception

        { & $payloadPath -GraphAccessToken 'graph-token-that-must-not-appear' -TenantDomain 'school.onmicrosoft.com' } |
            Should -Throw '*POST https://graph.microsoft.com/beta/security/rules/detectionRules; HTTP 400; code: BadRequest; message: Invalid automatedActions payload.; request-id: request-123; response date: 2026-07-13T13:00:00Z*'
        try {
            & $payloadPath -GraphAccessToken 'graph-token-that-must-not-appear' -TenantDomain 'school.onmicrosoft.com'
        } catch {
            $_.Exception.ToString() | Should -Not -Match 'graph-token-that-must-not-appear'
        }
    }
}
