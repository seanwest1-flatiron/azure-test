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
$payloadVersion = [Uri]::EscapeDataString([string]$manifest.payloadVersion)
$baseline = Invoke-RestMethod -Method GET -Uri "$repositoryBase/payloads/tenant-seed.json?version=$payloadVersion"
$definition = Invoke-RestMethod -Method GET -Uri "$repositoryBase/payloads/failed-sign-in-detection.json?version=$payloadVersion"
if ([string]::IsNullOrWhiteSpace($TenantDomain) -or [Uri]::CheckHostName($TenantDomain) -ne [UriHostNameType]::Dns) {
    throw 'TenantDomain must be a valid DNS domain resolved from the connected tenant.'
}
if ([string]::IsNullOrWhiteSpace([string]$baseline.failedSignInLab.applicationDisplayName) -or [string]::IsNullOrWhiteSpace([string]$baseline.failedSignInLab.userAlias)) {
    throw 'The tenant baseline does not contain failed sign-in application configuration.'
}
if (@($baseline.users | Where-Object { $_.userAlias -eq $baseline.failedSignInLab.userAlias }).Count -ne 1) {
    throw "The failed sign-in target alias '$($baseline.failedSignInLab.userAlias)' is not a configured baseline user."
}
if ([string]::IsNullOrWhiteSpace([string]$definition.id) -or [int]$definition.threshold -lt 3 -or [int]$definition.windowMinutes -lt 1 -or [int]$definition.windowMinutes -gt 60) {
    throw 'The failed sign-in custom detection configuration must require at least three failures within no more than one hour.'
}

function Get-GraphStatusCode {
    param($ErrorRecord)
    if ($ErrorRecord.Exception.Data.Contains('StatusCode')) { return [int]$ErrorRecord.Exception.Data['StatusCode'] }
    if ($null -ne $ErrorRecord.Exception.Response -and $null -ne $ErrorRecord.Exception.Response.StatusCode) {
        if ($null -ne $ErrorRecord.Exception.Response.StatusCode.value__) { return [int]$ErrorRecord.Exception.Response.StatusCode.value__ }
        return [int]$ErrorRecord.Exception.Response.StatusCode
    }
    if ($ErrorRecord.Exception.Message -match '\b([45][0-9]{2})\b') { return [int]$Matches[1] }
    return 0
}

function Invoke-Graph {
    param([string] $Method, [string] $Path, $Body, [string] $ApiVersion = 'v1.0')
    $uri = "https://graph.microsoft.com/$ApiVersion$Path"
    $parameters = @{ Method = $Method; Uri = $uri; Headers = @{ Authorization = "Bearer $GraphAccessToken" } }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 12
    }
    try {
        return Invoke-RestMethod @parameters
    } catch {
        $statusCode = Get-GraphStatusCode -ErrorRecord $_
        $errorBody = $_.ErrorDetails.Message
        $graphCode = 'Unknown'
        $graphMessage = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace([string]$errorBody)) {
            try {
                $graphError = $errorBody | ConvertFrom-Json
                if ($graphError.error.code) { $graphCode = [string]$graphError.error.code }
                if ($graphError.error.message) { $graphMessage = [string]$graphError.error.message }
            } catch { }
        }
        $statusText = if ($statusCode) { [string]$statusCode } else { 'unknown' }
        $exception = [System.Exception]::new("Microsoft Graph request failed: $Method $uri; HTTP $statusText; code: $graphCode; message: $graphMessage", $_.Exception)
        if ($statusCode) { $exception.Data['StatusCode'] = $statusCode }
        throw $exception
    }
}

$userPrincipalName = "$($baseline.failedSignInLab.userAlias)@$TenantDomain"
$escapedDisplayName = [string]$baseline.failedSignInLab.applicationDisplayName -replace "'", "''"
$filter = [Uri]::EscapeDataString("displayName eq '$escapedDisplayName'")
$applications = @((Invoke-Graph -Method GET -Path "/applications?`$filter=$filter&`$select=id,appId,displayName").value)
if ($applications.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$applications[0].appId)) {
    throw "The dedicated failed sign-in application '$($baseline.failedSignInLab.applicationDisplayName)' was not found uniquely in the tenant."
}
$applicationId = [string]$applications[0].appId
$escapedUpn = $userPrincipalName -replace "'", "''"
$escapedApplicationId = $applicationId -replace "'", "''"
$query = @"
EntraIdSignInEvents
| where Timestamp > ago($([int]$definition.windowMinutes)m)
| where AccountUpn =~ '$escapedUpn'
| where ApplicationId == '$escapedApplicationId'
| where ErrorCode == 50126
| summarize arg_max(Timestamp, ReportId), FailureCount = count(), CorrelationIds = make_set(CorrelationId, $([int]$definition.threshold)) by AccountUpn, ApplicationId
| where FailureCount >= $([int]$definition.threshold)
| project Timestamp, ReportId, AccountUpn, ApplicationId, FailureCount, CorrelationIds
"@.Trim()
$rule = @{
    '@odata.type' = '#microsoft.graph.security.detectionRule'
    id = [string]$definition.id
    displayName = [string]$definition.displayName
    description = [string]$definition.description
    status = 'enabled'
    queryCondition = @{ queryText = $query }
    schedule = @{ frequency = [string]$definition.frequency }
    detectionAction = @{
        alertTemplate = @{
            title = [string]$definition.displayName
            description = [string]$definition.description
            severity = [string]$definition.severity
            category = [string]$definition.category
            recommendedActions = 'Review the related sign-in activity.'
        }
        automatedActions = @{}
    }
}
$path = "/security/rules/detectionRules/$([Uri]::EscapeDataString([string]$definition.id))"
$created = $false
try {
    Invoke-Graph -Method GET -Path $path -ApiVersion beta | Out-Null
    Invoke-Graph -Method PATCH -Path $path -Body $rule -ApiVersion beta | Out-Null
} catch {
    if ((Get-GraphStatusCode -ErrorRecord $_) -ne 404) { throw }
    Invoke-Graph -Method POST -Path '/security/rules/detectionRules' -Body $rule -ApiVersion beta | Out-Null
    $created = $true
}
$verified = Invoke-Graph -Method GET -Path $path -ApiVersion beta
if ($verified.status -ne 'enabled') { throw "Custom detection '$($definition.id)' was not enabled." }
if ($verified.queryCondition.queryText -ne $query) { throw "Custom detection '$($definition.id)' query verification failed." }
$automatedActions = $verified.detectionAction.automatedActions
$automatedActionCount = if ($null -eq $automatedActions) { 0 } else { @($automatedActions.psobject.Properties).Count }
$legacyResponseActions = $verified.detectionAction.responseActions
$legacyResponseActionCount = if ($null -eq $legacyResponseActions) { 0 } else { @($legacyResponseActions).Count }
if ($automatedActionCount -or $legacyResponseActionCount) { throw "Custom detection '$($definition.id)' unexpectedly contains a remediation action." }
$verb = if ($created) { 'created' } else { 'repaired' }
Write-Output "Custom detection '$($definition.displayName)' $verb and enabled for $userPrincipalName through '$($baseline.failedSignInLab.applicationDisplayName)'. The rule is alert-only with no automated remediation."
