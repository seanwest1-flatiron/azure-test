#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken,
    [Parameter(Mandatory)]
    [string] $TenantDomain,
    [Parameter(Mandatory)]
    [string] $SubscriptionId,
    [Parameter(Mandatory)]
    [string] $ResourceGroup
)

$ErrorActionPreference = 'Stop'
$repositoryBase = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main'

function Get-JwtClaim {
    param([string] $AccessToken, [string] $Name)
    $segments = $AccessToken.Split('.')
    if ($segments.Count -lt 2) { throw 'The managed identity Graph access token was not a valid JWT.' }
    $encodedPayload = $segments[1].Replace('-', '+').Replace('_', '/')
    switch ($encodedPayload.Length % 4) { 2 { $encodedPayload += '==' } 3 { $encodedPayload += '=' } }
    try {
        $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload)) | ConvertFrom-Json
        return [string]$payload.$Name
    } catch { throw 'The managed identity Graph access token payload could not be decoded.' }
}

function Get-HttpErrorDetail {
    param($ErrorRecord)
    $status = $null
    try { $status = [int]$ErrorRecord.Exception.Response.StatusCode } catch { }
    $message = [string]$ErrorRecord.Exception.Message
    $detail = [string]$ErrorRecord.ErrorDetails.Message
    if ([string]::IsNullOrWhiteSpace($detail)) {
        try {
            if ($ErrorRecord.Exception.Response.Content) {
                $detail = [string]$ErrorRecord.Exception.Response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            }
        } catch { }
    }
    if (-not [string]::IsNullOrWhiteSpace($detail)) {
        try {
            $parsed = $detail | ConvertFrom-Json
            if ($parsed.error.code -or $parsed.error.message) { $message = "$($parsed.error.code): $($parsed.error.message)" }
        } catch { }
    }
    if ($status) { return "HTTP $status; $message" }
    return $message
}

function Invoke-Graph {
    param([string] $Method, [string] $Path, $Body)
    $parameters = @{ Method = $Method; Uri = "https://graph.microsoft.com/v1.0$Path"; Headers = @{ Authorization = "Bearer $GraphAccessToken" } }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 12
    }
    try { return Invoke-RestMethod @parameters } catch { throw "Microsoft Graph $Method $Path failed: $(Get-HttpErrorDetail -ErrorRecord $_)" }
}

function Get-ArmAccessToken {
    $response = Invoke-RestMethod -Method GET -Uri ("{0}?resource={1}&api-version=2019-08-01" -f $env:IDENTITY_ENDPOINT, [Uri]::EscapeDataString('https://management.azure.com/')) -Headers @{ 'X-IDENTITY-HEADER' = $env:IDENTITY_HEADER; Metadata = 'True' }
    if ([string]::IsNullOrWhiteSpace([string]$response.access_token)) { throw 'Azure managed identity endpoint did not return an Azure Resource Manager access token.' }
    return [string]$response.access_token
}

function Invoke-Arm {
    param([string] $Method, [string] $Path, $Body)
    $parameters = @{ Method = $Method; Uri = "https://management.azure.com$Path"; Headers = @{ Authorization = "Bearer $armAccessToken" } }
    if ($PSBoundParameters.ContainsKey('Body')) { $parameters.ContentType = 'application/json'; $parameters.Body = $Body | ConvertTo-Json -Depth 16 }
    Invoke-RestMethod @parameters
}

function Test-ContainerGroupDeploymentNotReady {
    param($ErrorRecord)
    $details = @([string]$ErrorRecord.Exception.Message, [string]$ErrorRecord.ErrorDetails.Message)
    return @($details | Where-Object { $_ -match 'ContainerGroupDeploymentNotReady' }).Count -gt 0
}

$manifest = Invoke-RestMethod -Method GET -Uri "$repositoryBase/version.json?nonce=$([Guid]::NewGuid().ToString('N'))"
if ([string]::IsNullOrWhiteSpace([string]$manifest.payloadVersion)) { throw 'The After Party version manifest did not contain a payload version.' }
$payloadVersion = [string]$manifest.payloadVersion
$baselineUri = "$repositoryBase/payloads/tenant-seed.json?version=$([Uri]::EscapeDataString($payloadVersion))"
$baseline = Invoke-RestMethod -Method GET -Uri $baselineUri
$alias = [string]$baseline.failedSignInLab.userAlias
if ($alias -ne 'lisa.simpson' -or @($baseline.users | Where-Object { $_.userAlias -eq $alias -and $_.displayName -eq 'Lisa Simpson' }).Count -ne 1) {
    throw 'The tenant baseline does not uniquely identify Lisa Simpson for TAP sign-in.'
}
$userPrincipalName = "$alias@$TenantDomain"
$encodedUpn = [Uri]::EscapeDataString($userPrincipalName)
$user = Invoke-Graph -Method GET -Path "/users/${encodedUpn}?`$select=id,displayName,userPrincipalName"
if ($user.displayName -ne 'Lisa Simpson' -or [string]$user.userPrincipalName -ine $userPrincipalName) { throw 'Microsoft Graph did not resolve the expected Lisa Simpson identity.' }

$applicationName = [string]$baseline.failedSignInLab.applicationDisplayName
$escapedApplicationName = $applicationName -replace "'", "''"
$applicationFilter = [Uri]::EscapeDataString("displayName eq '$escapedApplicationName'")
$applications = @((Invoke-Graph -Method GET -Path "/applications?`$filter=$applicationFilter&`$select=appId,displayName,isFallbackPublicClient,signInAudience,publicClient").value)
if ($applications.Count -ne 1 -or -not $applications[0].isFallbackPublicClient -or @($applications[0].publicClient.redirectUris) -notcontains 'http://localhost') {
    throw "The dedicated public client '$applicationName' is not configured for the localhost PKCE redirect."
}
$clientId = [string]$applications[0].appId
if ([string]::IsNullOrWhiteSpace($clientId)) { throw "The dedicated public client '$applicationName' did not have an application ID." }

$tenantId = Get-JwtClaim -AccessToken $GraphAccessToken -Name 'tid'
if ([string]::IsNullOrWhiteSpace($tenantId)) { throw 'The managed identity Graph access token did not contain a tenant ID.' }
$armAccessToken = Get-ArmAccessToken
$resourceGroupPath = "/subscriptions/$([Uri]::EscapeDataString($SubscriptionId))/resourcegroups/$([Uri]::EscapeDataString($ResourceGroup))"
$resourceGroupDetails = Invoke-Arm -Method GET -Path "${resourceGroupPath}?api-version=2021-04-01"
$workerName = "after-party-tap-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$containerPath = "$resourceGroupPath/providers/Microsoft.ContainerInstance/containerGroups/$workerName"
$workerUri = "$repositoryBase/payloads/tap-sign-in-worker.mjs?version=$([Uri]::EscapeDataString($payloadVersion))"
$command = "set -eu; mkdir -p /work; cd /work; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent --no-audit --no-fund --no-save playwright@1.61.0; curl --fail --silent --show-error '$workerUri' --output worker.mjs; node worker.mjs"

$tapId = $null
$temporaryAccessPass = $null
$containerAttempted = $false
$primaryError = $null
$cleanupErrors = @()
try {
    $existingTapMethods = @((Invoke-Graph -Method GET -Path "/users/$($user.id)/authentication/temporaryAccessPassMethods").value)
    if ($existingTapMethods.Count) { throw 'Lisa Simpson already has a Temporary Access Pass method. The lab did not replace or expose it.' }
    $tap = Invoke-Graph -Method POST -Path "/users/$($user.id)/authentication/temporaryAccessPassMethods" -Body @{ lifetimeInMinutes = 10; isUsableOnce = $true }
    $tapId = [string]$tap.id
    $temporaryAccessPass = [string]$tap.temporaryAccessPass
    if ([string]::IsNullOrWhiteSpace($tapId) -or [string]::IsNullOrWhiteSpace($temporaryAccessPass)) { throw 'Microsoft Graph did not return a usable one-time Temporary Access Pass.' }

    $containerGroup = @{
        location = $resourceGroupDetails.location
        properties = @{
            osType = 'Linux'
            restartPolicy = 'Never'
            containers = @(@{
                name = 'tap-browser-worker'
                properties = @{
                    image = 'mcr.microsoft.com/playwright:v1.61.0-noble'
                    command = @('/bin/sh', '-c', $command)
                    resources = @{ requests = @{ cpu = 1; memoryInGB = 2 } }
                    environmentVariables = @(
                        @{ name = 'TENANT_ID'; value = $tenantId },
                        @{ name = 'TENANT_DOMAIN'; value = $TenantDomain },
                        @{ name = 'CLIENT_ID'; value = $clientId },
                        @{ name = 'USER_ALIAS'; value = $alias },
                        @{ name = 'TEMPORARY_ACCESS_PASS'; secureValue = $temporaryAccessPass }
                    )
                }
            })
        }
    }

    $containerAttempted = $true
    Invoke-Arm -Method PUT -Path "${containerPath}?api-version=2023-05-01" -Body $containerGroup | Out-Null
    $container = $null
    for ($attempt = 1; $attempt -le 180; $attempt += 1) {
        $container = Invoke-Arm -Method GET -Path "${containerPath}?api-version=2023-05-01"
        if ([string]$container.properties.containers[0].properties.instanceView.currentState.state -eq 'Terminated') { break }
        Start-Sleep -Seconds 2
    }
    if ($null -eq $container -or [string]$container.properties.containers[0].properties.instanceView.currentState.state -ne 'Terminated') { throw 'The TAP browser worker did not finish within six minutes.' }

    $logs = $null
    for ($attempt = 1; $attempt -le 10; $attempt += 1) {
        try {
            $logs = Invoke-Arm -Method GET -Path "$containerPath/containers/tap-browser-worker/logs?api-version=2023-05-01&tail=50"
            break
        } catch {
            if (-not (Test-ContainerGroupDeploymentNotReady -ErrorRecord $_) -or $attempt -eq 10) { throw }
            Start-Sleep -Seconds 3
        }
    }
    $resultLine = @(([string]$logs.content -split "`r?`n") | Where-Object { $_ -like 'TAP_SIGN_IN_RESULT *' } | Select-Object -Last 1)
    if (-not $resultLine) { throw 'The TAP browser worker did not return a bounded sign-in result.' }
    $result = ($resultLine -replace '^TAP_SIGN_IN_RESULT\s+', '') | ConvertFrom-Json
    if ($result.result -eq 'registration_interrupted') { throw 'Microsoft required security-information or MFA registration. No authentication method was registered.' }
    if ($result.result -ne 'confirmed' -or $result.displayName -ne 'Lisa Simpson' -or [string]$result.upn -ine $userPrincipalName -or [string]$result.tenantId -ine $tenantId) {
        $workerMessage = if ([string]::IsNullOrWhiteSpace([string]$result.message)) { [string]$result.result } else { [string]$result.message }
        throw "The TAP browser worker did not confirm Lisa Simpson through Microsoft Graph /me. $workerMessage"
    }
} catch {
    $primaryError = $_
} finally {
    $temporaryAccessPass = $null
    if ($containerAttempted) {
        try { Invoke-Arm -Method DELETE -Path "${containerPath}?api-version=2023-05-01" | Out-Null } catch { $cleanupErrors += "temporary browser container: $(Get-HttpErrorDetail -ErrorRecord $_)" }
    }
    if (-not [string]::IsNullOrWhiteSpace($tapId)) {
        try { Invoke-Graph -Method DELETE -Path "/users/$($user.id)/authentication/temporaryAccessPassMethods/$([Uri]::EscapeDataString($tapId))" | Out-Null } catch { $cleanupErrors += "Temporary Access Pass: $($_.Exception.Message)" }
    }
}

if ($cleanupErrors.Count) { throw "TAP sign-in cleanup did not complete for $($cleanupErrors -join '; ')." }
if ($primaryError) { throw $primaryError }
Write-Output 'Lisa Simpson signed in with a Temporary Access Pass and Microsoft Graph /me confirmed her delegated identity. Cleanup completed.'
