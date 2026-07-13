#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken,
    [Parameter(Mandatory)]
    [string] $TenantDomain
)

$ErrorActionPreference = 'Stop'
$repositoryBase = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main'
$manifest = Invoke-RestMethod -Method GET -Uri "$repositoryBase/version.json?nonce=$([Guid]::NewGuid().ToString('N'))"
if ([string]::IsNullOrWhiteSpace([string]$manifest.payloadVersion)) {
    throw 'The After Party version manifest did not contain a payload version.'
}
$baseline = Invoke-RestMethod -Method GET -Uri "$repositoryBase/payloads/tenant-seed.json?version=$([Uri]::EscapeDataString([string]$manifest.payloadVersion))"
$targetAlias = [string]$baseline.failedSignInLab.userAlias
$protectedAliases = @('cory', 'kobe', 'rocky', 'socky')
if ($protectedAliases -contains $targetAlias) {
    throw "The password-reset target '$targetAlias' is a protected West family account."
}
$targetUsers = @($baseline.users | Where-Object { $_.userAlias -eq $targetAlias -and $_.displayName -eq 'Lisa Simpson' })
if ($targetAlias -ne 'lisa.simpson' -or $targetUsers.Count -ne 1) {
    throw 'The tenant baseline did not resolve the password-reset target uniquely to Lisa Simpson.'
}
if ([string]::IsNullOrWhiteSpace($TenantDomain) -or [Uri]::CheckHostName($TenantDomain) -ne [UriHostNameType]::Dns) {
    throw 'The resolved tenant domain was not a valid DNS domain.'
}
$userPrincipalName = "$targetAlias@$TenantDomain"

function Get-CryptographicRandomIndex {
    param(
        [Parameter(Mandatory)]
        [Security.Cryptography.RandomNumberGenerator] $Generator,
        [Parameter(Mandatory)]
        [ValidateRange(1, 255)]
        [int] $Maximum
    )

    $randomByte = New-Object byte[] 1
    $upperBound = 256 - (256 % $Maximum)
    do { $Generator.GetBytes($randomByte) } while ([int]$randomByte[0] -ge $upperBound)
    return [int]$randomByte[0] % $Maximum
}

function New-StrongRandomPassword {
    $characterSets = @(
        'ABCDEFGHJKLMNPQRSTUVWXYZ',
        'abcdefghijkmnopqrstuvwxyz',
        '23456789',
        '!@#$%^&*()-_=+'
    )
    $allCharacters = $characterSets -join ''
    $characters = [Collections.Generic.List[char]]::new()
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        foreach ($characterSet in $characterSets) {
            $characters.Add($characterSet[(Get-CryptographicRandomIndex -Generator $generator -Maximum $characterSet.Length)])
        }
        while ($characters.Count -lt 32) {
            $characters.Add($allCharacters[(Get-CryptographicRandomIndex -Generator $generator -Maximum $allCharacters.Length)])
        }
        for ($index = $characters.Count - 1; $index -gt 0; $index -= 1) {
            $swapIndex = Get-CryptographicRandomIndex -Generator $generator -Maximum ($index + 1)
            $temporary = $characters[$index]
            $characters[$index] = $characters[$swapIndex]
            $characters[$swapIndex] = $temporary
        }
        return -join $characters
    } finally {
        $generator.Dispose()
    }
}

$password = New-StrongRandomPassword
$request = @{
    passwordProfile = @{
        password = $password
        forceChangePasswordNextSignIn = $false
    }
}
$requestBody = $request | ConvertTo-Json -Depth 4
try {
    Invoke-RestMethod `
        -Method PATCH `
        -Uri "https://graph.microsoft.com/v1.0/users/$([Uri]::EscapeDataString($userPrincipalName))" `
        -Headers @{ Authorization = "Bearer $GraphAccessToken" } `
        -ContentType 'application/json' `
        -Body $requestBody | Out-Null
} catch {
    throw 'Microsoft Graph did not reset Lisa Simpson''s password.'
} finally {
    $requestBody = $null
    $request = $null
    $password = $null
}

Write-Output "Lisa Simpson's password was reset successfully."
