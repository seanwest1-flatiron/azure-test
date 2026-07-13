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
$payloadVersion = [Uri]::EscapeDataString([string]$manifest.payloadVersion)
$baseline = Invoke-RestMethod -Method GET -Uri "$repositoryBase/payloads/tenant-seed.json?version=$payloadVersion"
$definition = Invoke-RestMethod -Method GET -Uri "$repositoryBase/payloads/failed-sign-in-detection.json?version=$payloadVersion"

function Invoke-GraphJson {
    param([string] $Method, [string] $Path, $Body)
    $parameters = @{
        Method = $Method
        Uri = "https://graph.microsoft.com/beta$Path"
        Headers = @{ Authorization = "Bearer $GraphAccessToken" }
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 10
    }
    Invoke-RestMethod @parameters
}

if ([string]::IsNullOrWhiteSpace($TenantDomain) -or [Uri]::CheckHostName($TenantDomain) -ne [UriHostNameType]::Dns) {
    throw 'The resolved tenant domain was not a valid DNS domain.'
}
$applicationName = [string]$baseline.failedSignInLab.applicationDisplayName
$applicationFilter = [Uri]::EscapeDataString("displayName eq '$($applicationName -replace "'", "''")'")
$applications = @((Invoke-RestMethod -Method GET -Uri "https://graph.microsoft.com/v1.0/applications?`$filter=$applicationFilter&`$select=appId,displayName" -Headers @{ Authorization = "Bearer $GraphAccessToken" }).value)
if ($applications.Count -ne 1) { throw "The dedicated failed sign-in application '$applicationName' was not found uniquely." }

$rulePath = "/security/rules/detectionRules/$([Uri]::EscapeDataString([string]$definition.id))"
$rule = $null
try {
    $rule = Invoke-GraphJson -Method GET -Path $rulePath
} catch {
    $statusCode = if ($_.Exception.Data.Contains('StatusCode')) { [int]$_.Exception.Data['StatusCode'] } elseif ($_.Exception.Response.StatusCode.value__) { [int]$_.Exception.Response.StatusCode.value__ } else { [int]$_.Exception.Response.StatusCode }
    if ($statusCode -ne 404) { throw }
}

$userPrincipalName = "$($baseline.failedSignInLab.userAlias)@$TenantDomain"
$applicationId = [string]$applications[0].appId
$eventQuery = @"
EntraIdSignInEvents
| where Timestamp > ago(3h)
| where AccountUpn =~ '$($userPrincipalName -replace "'", "''")'
| where ApplicationId == '$($applicationId -replace "'", "''")'
| where ErrorCode == 50126
| project Timestamp, ReportId, AccountUpn, ApplicationId, ErrorCode, CorrelationId
| order by Timestamp desc
"@.Trim()
$alertQuery = @"
AlertInfo
| where Timestamp > ago(6h)
| where Title == '$(([string]$definition.displayName) -replace "'", "''")'
| project Timestamp, AlertId, Title, Severity, Category, DetectionSource, ServiceSource
| order by Timestamp desc
"@.Trim()
$events = @((Invoke-GraphJson -Method POST -Path '/security/runHuntingQuery' -Body @{ Query = $eventQuery; Timespan = 'PT3H' }).results)
$alerts = @((Invoke-GraphJson -Method POST -Path '/security/runHuntingQuery' -Body @{ Query = $alertQuery; Timespan = 'PT6H' }).results)

$automatedActionCount = if ($null -eq $rule -or $null -eq $rule.detectionAction.automatedActions) { 0 } else { @($rule.detectionAction.automatedActions.psobject.Properties).Count }
$responseActionCount = if ($null -eq $rule -or $null -eq $rule.detectionAction.responseActions) { 0 } else { @($rule.detectionAction.responseActions).Count }
$result = [ordered]@{
    tenantDomain = $TenantDomain
    userPrincipalName = $userPrincipalName
    applicationId = $applicationId
    ruleExists = $null -ne $rule
    rule = if ($null -eq $rule) { $null } else { [ordered]@{
        id = $rule.id
        displayName = $rule.displayName
        status = $rule.status
        queryText = $rule.queryCondition.queryText
        frequency = $rule.schedule.frequency
        automatedActionCount = $automatedActionCount
        responseActionCount = $responseActionCount
        lastRunDetails = $rule.lastRunDetails
    } }
    qualifyingEvents = $events
    matchingAlerts = $alerts
}
Write-Output "AFTER_PARTY_LIVE_RESULT=$($result | ConvertTo-Json -Depth 12 -Compress)"
