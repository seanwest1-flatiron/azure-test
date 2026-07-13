Describe 'Lisa Simpson password reset payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/reset-lisa-password.ps1'
    }

    BeforeEach {
        $global:AfterPartyPasswordResetRequest = $null
        $global:AfterPartyPasswordResetUri = $null
        $global:AfterPartyPasswordResetBaseline = [pscustomobject]@{
            failedSignInLab = [pscustomobject]@{ userAlias = 'lisa.simpson' }
            users = @(
                [pscustomobject]@{ userAlias = 'cory'; displayName = 'Cory West' },
                [pscustomobject]@{ userAlias = 'kobe'; displayName = 'Kobe West' },
                [pscustomobject]@{ userAlias = 'rocky'; displayName = 'Rocky West' },
                [pscustomobject]@{ userAlias = 'socky'; displayName = 'Socky West' },
                [pscustomobject]@{ userAlias = 'lisa.simpson'; displayName = 'Lisa Simpson' }
            )
        }
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Uri -like '*/version.json?nonce=*') { return [pscustomobject]@{ payloadVersion = 'payload-version' } }
            if ($Uri -like '*/payloads/tenant-seed.json?version=*') { return $global:AfterPartyPasswordResetBaseline }
            if ($Method -eq 'PATCH' -and $Uri -like 'https://graph.microsoft.com/v1.0/users/*') {
                $global:AfterPartyPasswordResetUri = [string]$Uri
                $global:AfterPartyPasswordResetRequest = $Body | ConvertFrom-Json
                return
            }
            throw "Unexpected REST request: $Method $Uri"
        }
    }

    It 'resets only Lisa at the tenant-relative UPN with a strong password profile' {
        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'student.onmicrosoft.com'

        $global:AfterPartyPasswordResetUri | Should -Be 'https://graph.microsoft.com/v1.0/users/lisa.simpson%40student.onmicrosoft.com'
        $profile = $global:AfterPartyPasswordResetRequest.passwordProfile
        $profile.forceChangePasswordNextSignIn | Should -BeFalse
        $profile.password.Length | Should -Be 32
        $profile.password | Should -Match '[A-Z]'
        $profile.password | Should -Match '[a-z]'
        $profile.password | Should -Match '[0-9]'
        $profile.password | Should -Match '[^A-Za-z0-9]'
        @($output).Count | Should -Be 1
        $output | Should -Be "Lisa Simpson's password was reset successfully."
        ($output -join "`n") | Should -Not -Match ([regex]::Escape($profile.password))
    }

    It 'rejects every protected West family alias before sending a password update' -ForEach @('cory', 'kobe', 'rocky', 'socky') {
        $global:AfterPartyPasswordResetBaseline.failedSignInLab.userAlias = $_

        { & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'student.onmicrosoft.com' } |
            Should -Throw "*protected West family account*"
        Should -Invoke Invoke-RestMethod -Times 0 -ParameterFilter {
            $Method -eq 'PATCH' -and $Uri -like 'https://graph.microsoft.com/v1.0/users/*'
        }
    }
}
