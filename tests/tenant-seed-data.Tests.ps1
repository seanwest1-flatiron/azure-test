Describe 'Version-controlled tenant baseline data' {
    BeforeAll {
        $seedPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/tenant-seed.json'
        $seed = Get-Content -Raw -Path $seedPath | ConvertFrom-Json
        $usersByUpn = @{}
        foreach ($user in $seed.users) { $usersByUpn[([string]$user.userPrincipalName).ToLowerInvariant()] = $user }
    }

    It 'defines the four West users with their exact names' {
        $usersByUpn['cory@corywest.onmicrosoft.com'].displayName | Should -Be 'Cory West'
        $usersByUpn['kobe@corywest.onmicrosoft.com'].displayName | Should -Be 'Kobe West'
        $usersByUpn['rocky@corywest.onmicrosoft.com'].displayName | Should -Be 'Rocky West'
        $usersByUpn['socky@corywest.onmicrosoft.com'].displayName | Should -Be 'Socky West'
    }

    It 'keeps All Employees as the licensing group' {
        $seed.licensingGroup.displayName | Should -Be 'All Employees'
        $seed.licensingGroup.mailNickname | Should -Be 'allemployees'
    }

    It 'uses a dedicated public client for the failed sign-in generator' {
        $seed.failedSignInLab.clientId | Should -Be '7383ffdd-51f7-4cb2-8f4e-a7793939fdae'
        $seed.failedSignInLab.clientId | Should -Not -Be 'f1d183a6-1a01-4daf-b5ca-70f44427de17'
        $seed.failedSignInLab.userPrincipalName | Should -Be 'lisa.simpson@corywest.onmicrosoft.com'
        $seed.passwordRuleSettings.templateId | Should -Be '5cf42378-d67d-4f36-ba46-e8b86229381d'
        $seed.passwordRuleSettings.values.LockoutThreshold | Should -Be '100'
        $seed.passwordRuleSettings.values.LockoutDurationInSeconds | Should -Be '60'
    }

    It 'defines the expected department memberships' {
        $expected = @{
            'Executive' = @('cory@corywest.onmicrosoft.com', 'kobe@corywest.onmicrosoft.com')
            'IT' = @('socky@corywest.onmicrosoft.com')
            'Corporate Services' = @('rocky@corywest.onmicrosoft.com')
            'Security' = @('bart.simpson@corywest.onmicrosoft.com', 'homer.simpson@corywest.onmicrosoft.com', 'lisa.simpson@corywest.onmicrosoft.com', 'marge.simpson@corywest.onmicrosoft.com')
            'Finance' = @('chandler.bing@corywest.onmicrosoft.com', 'monica.geller@corywest.onmicrosoft.com', 'rachel.green@corywest.onmicrosoft.com', 'ross.geller@corywest.onmicrosoft.com')
            'Human Resources' = @('cosmo.kramer@corywest.onmicrosoft.com', 'elaine.benes@corywest.onmicrosoft.com', 'george.costanza@corywest.onmicrosoft.com', 'jerry.seinfeld@corywest.onmicrosoft.com')
        }

        $seed.departments.Count | Should -Be $expected.Count
        foreach ($department in $seed.departments) {
            $expected.ContainsKey([string]$department.displayName) | Should -Be $true
            @(Compare-Object -ReferenceObject @($expected[[string]$department.displayName] | Sort-Object) -DifferenceObject @($department.memberUserPrincipalNames | Sort-Object)).Count | Should -Be 0
            foreach ($upn in $department.memberUserPrincipalNames) {
                $usersByUpn.ContainsKey(([string]$upn).ToLowerInvariant()) | Should -Be $true
                $usersByUpn[([string]$upn).ToLowerInvariant()].department | Should -Be $department.displayName
            }
        }
    }

    It 'assigns every baseline user to exactly one configured department' {
        $configuredMemberships = @($seed.departments | ForEach-Object memberUserPrincipalNames)
        $configuredMemberships.Count | Should -Be $seed.users.Count
        @($configuredMemberships | Group-Object | Where-Object Count -ne 1).Count | Should -Be 0
    }
}
