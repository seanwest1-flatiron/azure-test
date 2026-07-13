Describe 'Version-controlled tenant baseline data' {
    BeforeAll {
        $seedPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/tenant-seed.json'
        $seedJson = Get-Content -Raw -Path $seedPath
        $seed = $seedJson | ConvertFrom-Json
        $usersByAlias = @{}
        foreach ($user in $seed.users) { $usersByAlias[([string]$user.userAlias).ToLowerInvariant()] = $user }
    }

    It 'defines the four West users with their exact names' {
        $usersByAlias.cory.displayName | Should -Be 'Cory West'
        $usersByAlias.kobe.displayName | Should -Be 'Kobe West'
        $usersByAlias.rocky.displayName | Should -Be 'Rocky West'
        $usersByAlias.socky.displayName | Should -Be 'Socky West'
    }

    It 'keeps All Employees as the licensing group' {
        $seed.licensingGroup.displayName | Should -Be 'All Employees'
        $seed.licensingGroup.mailNickname | Should -Be 'allemployees'
    }

    It 'uses a dedicated public client for the failed sign-in generator' {
        $seed.failedSignInLab.applicationDisplayName | Should -Be 'After Party Failed Sign-In Generator'
        $seed.failedSignInLab.userAlias | Should -Be 'lisa.simpson'
        $seed.passwordRuleSettings.templateId | Should -Be '5cf42378-d67d-4f36-ba46-e8b86229381d'
        $seed.passwordRuleSettings.values.LockoutThreshold | Should -Be '50'
        $seed.passwordRuleSettings.values.LockoutDurationInSeconds | Should -Be '60'
    }

    It 'keeps custom detection configuration out of the tenant baseline' {
        $seed.psobject.Properties.Name | Should -Not -Contain 'customDetections'
        (Get-Content -Raw (Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/seed-tenant.ps1')) | Should -Not -Match 'detectionRules|Set-LisaFailedSignInDetection'
    }

    It 'defines the expected department memberships' {
        $expected = @{
            'Executive' = @('cory', 'kobe')
            'IT' = @('socky')
            'Corporate Services' = @('rocky')
            'Security' = @('bart.simpson', 'homer.simpson', 'lisa.simpson', 'marge.simpson')
            'Finance' = @('chandler.bing', 'monica.geller', 'rachel.green', 'ross.geller')
            'Human Resources' = @('cosmo.kramer', 'elaine.benes', 'george.costanza', 'jerry.seinfeld')
        }

        $seed.departments.Count | Should -Be $expected.Count
        foreach ($department in $seed.departments) {
            $expected.ContainsKey([string]$department.displayName) | Should -Be $true
            @(Compare-Object -ReferenceObject @($expected[[string]$department.displayName] | Sort-Object) -DifferenceObject @($department.memberAliases | Sort-Object)).Count | Should -Be 0
            foreach ($userAlias in $department.memberAliases) {
                $usersByAlias.ContainsKey(([string]$userAlias).ToLowerInvariant()) | Should -Be $true
                $usersByAlias[([string]$userAlias).ToLowerInvariant()].department | Should -Be $department.displayName
            }
        }
    }

    It 'assigns every baseline user to exactly one configured department' {
        $configuredMemberships = @($seed.departments | ForEach-Object memberAliases)
        $configuredMemberships.Count | Should -Be $seed.users.Count
        @($configuredMemberships | Group-Object | Where-Object Count -ne 1).Count | Should -Be 0
    }

    It 'keeps portable seed data free of the development tenant domain and object IDs' {
        $seedJson | Should -Not -Match 'corywest\.onmicrosoft\.com'
        $seedJson | Should -Not -Match '7383ffdd-51f7-4cb2-8f4e-a7793939fdae'
    }

    It 'keeps portable runtime files free of the development tenant domain' {
        $repositoryRoot = Split-Path -Parent $PSScriptRoot
        $portableFiles = @(
            Get-ChildItem (Join-Path $repositoryRoot 'payloads') -File
            Get-ChildItem (Join-Path $repositoryRoot 'runbooks') -File
        )
        foreach ($file in $portableFiles) {
            (Get-Content -Raw $file.FullName) | Should -Not -Match 'corywest\.onmicrosoft\.com' -Because "$($file.FullName) must be tenant-portable"
        }
    }
}
