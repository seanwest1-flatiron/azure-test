#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter()]
    [ValidatePattern('^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ps1$')]
    [string] $LabPath = 'payloads/send-email.ps1',
    [Parameter()]
    [string] $SubscriptionId,
    [Parameter()]
    [string] $ResourceGroup,
    [Parameter()]
    [string] $AttemptCount
)

$ErrorActionPreference = 'Stop'
$installedRunnerVersion = '2026.07.13.6'
$repositoryBase = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main'
$manifest = Invoke-RestMethod -Method GET -Uri "$repositoryBase/version.json?nonce=$([Guid]::NewGuid().ToString('N'))"
if ([string]::IsNullOrWhiteSpace([string]$manifest.payloadVersion)) {
    throw 'The After Party version manifest did not contain a payload version.'
}
$payloadUrl = "$repositoryBase/${LabPath}?version=$([Uri]::EscapeDataString([string]$manifest.payloadVersion))"
$labUri = [Uri]$payloadUrl

if ($labUri.Scheme -ne 'https' -or $labUri.Host -ne 'raw.githubusercontent.com') {
    throw 'The payload URI is not an approved HTTPS GitHub raw-content URI.'
}

Write-Output "Installed runner version: $installedRunnerVersion"
Write-Output "Downloading current payload: $LabPath"
Write-Output "Resolved payload URL: $($labUri.AbsoluteUri)"
$labSource = (Invoke-WebRequest -Uri $labUri.AbsoluteUri -UseBasicParsing).Content
if ([string]::IsNullOrWhiteSpace($labSource)) {
    throw 'The downloaded payload was empty.'
}

function Get-AccessTokenRoles {
    param([string] $AccessToken)
    $segments = $AccessToken.Split('.')
    if ($segments.Count -lt 2) { throw 'The managed identity Graph access token was not a valid JWT.' }
    $encodedPayload = $segments[1].Replace('-', '+').Replace('_', '/')
    switch ($encodedPayload.Length % 4) {
        2 { $encodedPayload += '==' }
        3 { $encodedPayload += '=' }
    }
    try {
        $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload)) | ConvertFrom-Json
    } catch {
        throw 'The managed identity Graph access token payload could not be decoded.'
    }
    return @($payload.roles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
}

$requiredGraphRoles = @('Domain.Read.All')
switch ($LabPath) {
    'payloads/seed-tenant.ps1' {
        $requiredGraphRoles += @('Application.ReadWrite.All', 'User.ReadWrite.All', 'Group.ReadWrite.All', 'GroupMember.ReadWrite.All', 'LicenseAssignment.Read.All', 'LicenseAssignment.ReadWrite.All')
    }
    'payloads/failed-sign-in.ps1' { $requiredGraphRoles += 'Application.ReadWrite.All' }
    'payloads/browser-failed-sign-in.ps1' { $requiredGraphRoles += 'Application.ReadWrite.All' }
    'payloads/tap-sign-in.ps1' { $requiredGraphRoles += @('Application.ReadWrite.All', 'UserAuthMethod-TAP.ReadWrite.All') }
    'payloads/create-failed-sign-in-detection.ps1' { $requiredGraphRoles += @('Application.ReadWrite.All', 'CustomDetection.ReadWrite.All') }
    'payloads/reset-lisa-password.ps1' { $requiredGraphRoles += 'User-PasswordProfile.ReadWrite.All' }
    'payloads/share-onedrive-file.ps1' { $requiredGraphRoles += 'Files.ReadWrite.All' }
    'payloads/send-email.ps1' { $requiredGraphRoles += 'Mail.Send' }
    'payloads/send-message-batch.ps1' { $requiredGraphRoles += 'Mail.Send' }
    'payloads/send-customer-payment-export.ps1' { $requiredGraphRoles += 'Mail.Send' }
    'payloads/send-external-email.ps1' { $requiredGraphRoles += 'Mail.Send' }
}
$requiredGraphRoles = @($requiredGraphRoles | Sort-Object -Unique)

$graphAccessToken = $null
for ($attempt = 1; $attempt -le 13; $attempt += 1) {
    $tokenResponse = Invoke-RestMethod `
        -Method GET `
        -Uri ("{0}?resource={1}&api-version=2019-08-01" -f $env:IDENTITY_ENDPOINT, [Uri]::EscapeDataString('https://graph.microsoft.com')) `
        -Headers @{
            'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER
            Metadata = 'True'
        }
    if ([string]::IsNullOrWhiteSpace([string]$tokenResponse.access_token)) {
        throw 'Azure managed identity endpoint did not return a Graph access token.'
    }
    $tokenRoles = @(Get-AccessTokenRoles -AccessToken ([string]$tokenResponse.access_token))
    $missingRoles = @($requiredGraphRoles | Where-Object { $tokenRoles -notcontains $_ })
    if (-not $missingRoles.Count) {
        $graphAccessToken = [string]$tokenResponse.access_token
        break
    }
    if ($attempt -eq 13) {
        throw "The managed identity Graph token did not contain required roles after 60 seconds: $($missingRoles -join ', ')."
    }
    Write-Output "Waiting for managed identity Graph token propagation. Missing roles: $($missingRoles -join ', ')."
    Start-Sleep -Seconds 5
}

$domainResponse = Invoke-RestMethod `
    -Method GET `
    -Uri 'https://graph.microsoft.com/v1.0/domains?$select=id,isDefault,isInitial,isVerified' `
    -Headers @{ Authorization = "Bearer $graphAccessToken" }
$verifiedDomains = @($domainResponse.value | Where-Object { $_.isVerified })
$resolvedDomain = @($verifiedDomains | Where-Object { $_.isInitial } | Sort-Object id | Select-Object -First 1)
if (-not $resolvedDomain) { $resolvedDomain = @($verifiedDomains | Where-Object { $_.isDefault } | Sort-Object id | Select-Object -First 1) }
if (-not $resolvedDomain) { $resolvedDomain = @($verifiedDomains | Sort-Object id | Select-Object -First 1) }
$tenantDomain = [string]$resolvedDomain.id
if ([string]::IsNullOrWhiteSpace($tenantDomain) -or [Uri]::CheckHostName($tenantDomain) -ne [UriHostNameType]::Dns) {
    throw 'Microsoft Graph did not return a usable verified tenant domain.'
}
Write-Output "Resolved tenant domain: $tenantDomain"

$payload = [ScriptBlock]::Create($labSource)
$payloadParameters = @{ GraphAccessToken = $graphAccessToken; TenantDomain = $tenantDomain }
if ($LabPath -in @('payloads/browser-failed-sign-in.ps1', 'payloads/tap-sign-in.ps1')) {
    if ([string]::IsNullOrWhiteSpace($SubscriptionId) -or [string]::IsNullOrWhiteSpace($ResourceGroup)) {
        throw 'The browser payload requires the selected Azure subscription and resource group.'
    }
    $payloadParameters.SubscriptionId = $SubscriptionId
    $payloadParameters.ResourceGroup = $ResourceGroup
    if (-not [string]::IsNullOrWhiteSpace($AttemptCount)) { $payloadParameters.AttemptCount = $AttemptCount }
}
if ($LabPath -eq 'payloads/failed-sign-in.ps1' -and -not [string]::IsNullOrWhiteSpace($AttemptCount)) {
    $payloadParameters.AttemptCount = $AttemptCount
}
& $payload @payloadParameters
