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
