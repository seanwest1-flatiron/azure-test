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
    [string] $ResourceGroup,
    [Parameter()]
    [ValidateRange(1, 3)]
    [int] $AttemptCount = 1
)

$ErrorActionPreference = 'Stop'
$repositoryBase = 'https://raw.githubusercontent.com/seanwest1-flatiron/azure-test/main'
$manifest = Invoke-RestMethod -Method GET -Uri "$repositoryBase/version.json?nonce=$([Guid]::NewGuid().ToString('N'))"
if ([string]::IsNullOrWhiteSpace([string]$manifest.payloadVersion)) { throw 'The After Party version manifest did not contain a payload version.' }
$payloadVersion = [string]$manifest.payloadVersion
$baselineUri = "$repositoryBase/payloads/tenant-seed.json?version=$([Uri]::EscapeDataString($payloadVersion))"
$baseline = Invoke-RestMethod -Method GET -Uri $baselineUri
if ([string]::IsNullOrWhiteSpace([string]$baseline.failedSignInLab.applicationDisplayName) -or [string]::IsNullOrWhiteSpace([string]$baseline.failedSignInLab.userAlias)) {
    throw 'The tenant baseline does not contain browser failed sign-in configuration.'
}
if (@($baseline.users | Where-Object { $_.userAlias -eq $baseline.failedSignInLab.userAlias }).Count -ne 1) {
    throw "The browser failed sign-in target alias '$($baseline.failedSignInLab.userAlias)' is not a configured baseline user."
}
$userPrincipalName = "$($baseline.failedSignInLab.userAlias)@$TenantDomain"
$escapedDisplayName = [string]$baseline.failedSignInLab.applicationDisplayName -replace "'", "''"
$applicationFilter = [Uri]::EscapeDataString("displayName eq '$escapedDisplayName'")
$applications = @((Invoke-RestMethod -Method GET -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=$applicationFilter&`$select=appId,displayName,isFallbackPublicClient,signInAudience" -Headers @{ Authorization = "Bearer $GraphAccessToken" }).value)
if ($applications.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$applications[0].appId)) { throw "The dedicated failed sign-in application '$($baseline.failedSignInLab.applicationDisplayName)' was not found uniquely in the tenant." }
$clientId = [string]$applications[0].appId

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

function Invoke-GraphVerification {
    param([string] $UserPrincipalName, [string] $ApplicationId, [string] $OperationStartedUtc)
    try {
        $filter = "userPrincipalName eq '$($UserPrincipalName -replace "'", "''")' and appId eq '$ApplicationId' and createdDateTime ge $OperationStartedUtc"
        for ($attempt = 1; $attempt -le 3; $attempt += 1) {
            $uri = "https://graph.microsoft.com/v1.0/auditLogs/signIns?`$filter=$([Uri]::EscapeDataString($filter))&`$top=25"
            $records = @((Invoke-RestMethod -Method GET -Uri $uri -Headers @{ Authorization = "Bearer $GraphAccessToken" }).value | Where-Object { @($_.signInEventTypes) -contains 'interactiveUser' -and [int]$_.status.errorCode -ne 0 })
            if ($records.Count) { return "partially verified: $($records.Count) interactive failed sign-in record(s) found" }
            if ($attempt -lt 3) { Start-Sleep -Seconds 10 }
        }
        return 'pending: no matching interactive failed sign-in records were available yet'
    } catch {
        return "pending: sign-in log verification was unavailable ($($_.Exception.Message))"
    }
}

function Test-ContainerGroupDeploymentNotReady {
    param($ErrorRecord)
    $details = @([string]$ErrorRecord.Exception.Message, [string]$ErrorRecord.ErrorDetails.Message)
    return @($details | Where-Object { $_ -match '(^|[^A-Za-z])ContainerGroupDeploymentNotReady([^A-Za-z]|$)' }).Count -gt 0
}

function Get-ContainerDiagnosticSummary {
    param($Container)
    $containerDetails = $Container.properties.containers[0]
    $instanceView = $containerDetails.properties.instanceView
    $events = @($instanceView.events | Select-Object -Last 5 | ForEach-Object {
        $name = if ($_.name) { $_.name } else { 'event' }
        $message = if ($_.message) { $_.message } else { $_.count }
        "${name}: $message"
    }) -join ' | '
    if ([string]::IsNullOrWhiteSpace($events)) { $events = 'none' }
    return "Container logs remained unavailable after 30 seconds. Group state: $($Container.properties.instanceView.state); provisioning state: $($Container.properties.provisioningState); container state: $($instanceView.currentState.state); exit code: $($instanceView.currentState.exitCode); recent container events: $events"
}

$tenantId = Get-JwtClaim -AccessToken $GraphAccessToken -Name 'tid'
if ([string]::IsNullOrWhiteSpace($tenantId)) { throw 'The managed identity Graph access token did not contain a tenant ID.' }
$armAccessToken = Get-ArmAccessToken
$resourceGroupPath = "/subscriptions/$([Uri]::EscapeDataString($SubscriptionId))/resourcegroups/$([Uri]::EscapeDataString($ResourceGroup))"
$resourceGroupDetails = Invoke-Arm -Method GET -Path "${resourceGroupPath}?api-version=2021-04-01"
$workerName = "after-party-browser-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$containerPath = "$resourceGroupPath/providers/Microsoft.ContainerInstance/containerGroups/$workerName"
$workerUri = "$repositoryBase/payloads/browser-failed-sign-in-worker.mjs?version=$([Uri]::EscapeDataString($payloadVersion))"
$command = "set -eu; mkdir -p /work; cd /work; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --silent --no-audit --no-fund --no-save playwright@1.61.0; curl --fail --silent --show-error '$workerUri' --output worker.mjs; node worker.mjs"
$containerGroup = @{
    location = $resourceGroupDetails.location
    properties = @{
        osType = 'Linux'
        restartPolicy = 'Never'
        containers = @(@{
            name = 'browser-worker'
            properties = @{
                image = 'mcr.microsoft.com/playwright:v1.61.0-noble'
                command = @('/bin/sh', '-c', $command)
                resources = @{ requests = @{ cpu = 1; memoryInGB = 2 } }
                environmentVariables = @(
                    @{ name = 'TENANT_ID'; value = $tenantId },
                    @{ name = 'BASELINE_URL'; value = $baselineUri },
                    @{ name = 'TENANT_DOMAIN'; value = $TenantDomain },
                    @{ name = 'CLIENT_ID'; value = $clientId },
                    @{ name = 'USER_ALIAS'; value = [string]$baseline.failedSignInLab.userAlias },
                    @{ name = 'ATTEMPT_COUNT'; value = [string]$AttemptCount }
                )
            }
        })
    }
}

$created = $false
$operationStartedUtc = [DateTime]::UtcNow.ToString('o')
try {
    Invoke-Arm -Method PUT -Path "${containerPath}?api-version=2023-05-01" -Body $containerGroup | Out-Null
    $created = $true
    Write-Output "Started short-lived browser worker: $workerName"
    $container = $null
    for ($attempt = 1; $attempt -le 180; $attempt += 1) {
        $container = Invoke-Arm -Method GET -Path "${containerPath}?api-version=2023-05-01"
        $state = [string]$container.properties.containers[0].properties.instanceView.currentState.state
        if ($state -eq 'Terminated') { break }
        Start-Sleep -Seconds 2
    }
    if ($null -eq $container -or [string]$container.properties.containers[0].properties.instanceView.currentState.state -ne 'Terminated') { throw 'The browser worker did not finish within six minutes.' }
    $logs = $null
    for ($attempt = 1; $attempt -le 10; $attempt += 1) {
        try {
            $logs = Invoke-Arm -Method GET -Path "$containerPath/containers/browser-worker/logs?api-version=2023-05-01&tail=200"
            break
        } catch {
            if (-not (Test-ContainerGroupDeploymentNotReady -ErrorRecord $_)) { throw }
            if ($attempt -eq 10) { throw (Get-ContainerDiagnosticSummary -Container $container) }
            Start-Sleep -Seconds 3
        }
    }
    $content = [string]$logs.content
    if ([string]::IsNullOrWhiteSpace($content)) { throw 'The browser worker produced no diagnostic output.' }
    Write-Output $content
    $resultLine = @($content -split "`r?`n" | Where-Object { $_ -like 'BROWSER_SIGN_IN_RESULT *' } | Select-Object -Last 1)
    if (-not $resultLine) { throw 'The browser worker did not produce a sign-in result.' }
    $result = ($resultLine -replace '^BROWSER_SIGN_IN_RESULT\s+', '') | ConvertFrom-Json
    if ($AttemptCount -eq 1 -and $result.result -ne 'credentials_rejected') { throw "The browser worker did not confirm credential rejection. Result: $($result.result)" }
    if ($AttemptCount -eq 3) {
        if ($result.result -ne 'attempts_submitted' -or @($result.diagnostic.attempts).Count -ne 3) { throw "The browser worker did not submit three confirmed sign-in attempts. Result: $($result.result)" }
        $verification = Invoke-GraphVerification -UserPrincipalName $result.upn -ApplicationId $clientId -OperationStartedUtc $operationStartedUtc
        Write-Output "Three browser failed sign-ins submitted for $($result.upn). Worker outbound IP: $($result.diagnostic.workerOutboundIp). Entra verification: $verification."
    } else {
        Write-Output "Browser failed sign-in confirmed for $($result.upn) at $($result.timestampUtc)."
    }
} finally {
    if ($created) {
        try {
            Invoke-Arm -Method DELETE -Path "${containerPath}?api-version=2023-05-01" | Out-Null
            Write-Output "Deleted short-lived browser worker: $workerName"
        } catch {
            Write-Warning "Could not delete short-lived browser worker '$workerName': $($_.Exception.Message)"
        }
    }
}
