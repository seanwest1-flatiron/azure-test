#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$repositoryBase = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main'
$manifest = Invoke-RestMethod -Method GET -Uri "$repositoryBase/version.json?nonce=$([Guid]::NewGuid().ToString('N'))"
if ([string]::IsNullOrWhiteSpace([string]$manifest.payloadVersion)) {
    throw 'The After Party version manifest did not contain a payload version.'
}
$baselineUri = "$repositoryBase/payloads/tenant-seed.json?version=$([Uri]::EscapeDataString([string]$manifest.payloadVersion))"
$baseline = Invoke-RestMethod -Method GET -Uri $baselineUri
$lab = $baseline.failedSignInLab
if ([string]::IsNullOrWhiteSpace([string]$lab.clientId) -or [string]::IsNullOrWhiteSpace([string]$lab.userPrincipalName)) {
    throw 'The tenant baseline does not contain failed sign-in lab configuration.'
}
if (@($baseline.users | Where-Object { $_.userPrincipalName -eq $lab.userPrincipalName }).Count -ne 1) {
    throw "The failed sign-in target '$($lab.userPrincipalName)' is not a configured baseline user."
}

function Get-TokenPayload {
    param([string] $AccessToken)
    $segments = $AccessToken.Split('.')
    if ($segments.Count -lt 2) { throw 'The managed identity Graph access token was not a valid JWT.' }
    $encodedPayload = $segments[1].Replace('-', '+').Replace('_', '/')
    switch ($encodedPayload.Length % 4) {
        2 { $encodedPayload += '==' }
        3 { $encodedPayload += '=' }
    }
    try {
        $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))
        return $payloadJson | ConvertFrom-Json
    } catch {
        throw 'The managed identity Graph access token payload could not be decoded.'
    }
}

$tokenPayload = Get-TokenPayload -AccessToken $GraphAccessToken
$tenantId = [string]$tokenPayload.tid
if ([string]::IsNullOrWhiteSpace($tenantId)) { throw 'The managed identity Graph access token did not contain a tenant ID.' }
$tokenEndpoint = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
$invalidPassword = "AfterParty-Invalid-$([Guid]::NewGuid().ToString('N'))"
$form = @{
    client_id = [string]$lab.clientId
    scope = 'openid profile'
    username = [string]$lab.userPrincipalName
    password = $invalidPassword
    grant_type = 'password'
}

try {
    Invoke-RestMethod -Method POST -Uri $tokenEndpoint -ContentType 'application/x-www-form-urlencoded' -Body $form | Out-Null
    throw 'The failed sign-in request unexpectedly succeeded; no invalid-credentials record was generated.'
} catch {
    if ($_.Exception.Message -eq 'The failed sign-in request unexpectedly succeeded; no invalid-credentials record was generated.') { throw }
    $responseText = $_.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace([string]$responseText)) { throw }
    try {
        $response = $responseText | ConvertFrom-Json
    } catch {
        throw "The Entra token endpoint returned an unreadable error response: $($_.Exception.Message)"
    }
    $isInvalidCredentials = $response.error -eq 'invalid_grant' -and (@($response.error_codes) -contains 50126)
    if (-not $isInvalidCredentials) {
        throw "The Entra token endpoint did not return the expected invalid-credentials response. Error: $($response.error). Description: $($response.error_description)"
    }
    $entraCode = if ($response.error_description -match 'AADSTS[0-9]+') { $Matches[0] } else { 'invalid_grant' }
    Write-Output "Failed sign-in recorded for $($lab.userPrincipalName). Expected invalid-credentials response received: $entraCode."
    if ($response.correlation_id) { Write-Output "Entra correlation ID: $($response.correlation_id)" }
    if ($response.timestamp) { Write-Output "Entra timestamp: $($response.timestamp)" }
}
