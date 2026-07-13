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
$installedRunnerVersion = '2026.07.13.1'
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

$tokenResponse = Invoke-RestMethod `
    -Method GET `
    -Uri ("{0}?resource={1}&api-version=2019-08-01" -f $env:IDENTITY_ENDPOINT, [Uri]::EscapeDataString('https://graph.microsoft.com')) `
    -Headers @{
        'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER
        Metadata = 'True'
    }

if ([string]::IsNullOrWhiteSpace($tokenResponse.access_token)) {
    throw 'Azure managed identity endpoint did not return a Graph access token.'
}

$payload = [ScriptBlock]::Create($labSource)
$payloadParameters = @{ GraphAccessToken = $tokenResponse.access_token }
if ($LabPath -eq 'payloads/browser-failed-sign-in.ps1') {
    if ([string]::IsNullOrWhiteSpace($SubscriptionId) -or [string]::IsNullOrWhiteSpace($ResourceGroup)) {
        throw 'The browser failed sign-in payload requires the selected Azure subscription and resource group.'
    }
    $payloadParameters.SubscriptionId = $SubscriptionId
    $payloadParameters.ResourceGroup = $ResourceGroup
    if (-not [string]::IsNullOrWhiteSpace($AttemptCount)) { $payloadParameters.AttemptCount = $AttemptCount }
}
if ($LabPath -eq 'payloads/failed-sign-in.ps1' -and -not [string]::IsNullOrWhiteSpace($AttemptCount)) {
    $payloadParameters.AttemptCount = $AttemptCount
}
& $payload @payloadParameters
