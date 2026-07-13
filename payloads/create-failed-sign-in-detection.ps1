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
if ([string]::IsNullOrWhiteSpace([string]$definition.id) -or [int]$definition.threshold -lt 3 -or [int]$definition.windowMinutes -ne 60 -or [int]$definition.searchHorizonHours -ne 3) {
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

function Get-GraphResponseHeader {
    param($ErrorRecord, [string] $Name)
    if ($ErrorRecord.Exception.Data.Contains('ResponseHeaders')) {
        $dataHeaders = $ErrorRecord.Exception.Data['ResponseHeaders']
        if ($null -ne $dataHeaders -and $null -ne $dataHeaders[$Name]) { return [string]$dataHeaders[$Name] }
    }
    $headers = $ErrorRecord.Exception.Response.Headers
    if ($null -eq $headers) { return $null }
    try {
        $values = @($headers.GetValues($Name))
        if ($values.Count) { return [string]$values[0] }
    } catch { }
    try {
        $value = $headers[$Name]
        if ($null -ne $value) { return [string]$value }
    } catch { }
    try {
        $property = $headers.psobject.Properties | Where-Object { $_.Name -ieq $Name } | Select-Object -First 1
        if ($null -ne $property) { return [string]$property.Value }
    } catch { }
    return $null
}

function Get-GraphErrorBody {
    param($ErrorRecord)
    if (-not [string]::IsNullOrWhiteSpace([string]$ErrorRecord.ErrorDetails.Message)) {
        return [string]$ErrorRecord.ErrorDetails.Message
    }
    if ($ErrorRecord.Exception.Data.Contains('GraphErrorBody')) {
        return [string]$ErrorRecord.Exception.Data['GraphErrorBody']
    }
    try {
        $stream = $ErrorRecord.Exception.Response.GetResponseStream()
        if ($null -ne $stream) {
            $reader = [System.IO.StreamReader]::new($stream)
            try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
        }
    } catch { }
    return $null
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
        $errorBody = Get-GraphErrorBody -ErrorRecord $_
        $graphCode = 'Unknown'
        $graphMessage = $_.Exception.Message
        $requestId = Get-GraphResponseHeader -ErrorRecord $_ -Name 'request-id'
        $responseDate = Get-GraphResponseHeader -ErrorRecord $_ -Name 'Date'
        if (-not [string]::IsNullOrWhiteSpace([string]$errorBody)) {
            try {
                $graphError = $errorBody | ConvertFrom-Json
                if ($graphError.error.code) { $graphCode = [string]$graphError.error.code }
                if ($graphError.error.message) { $graphMessage = [string]$graphError.error.message }
                if ([string]::IsNullOrWhiteSpace($requestId) -and $graphError.error.innerError.'request-id') { $requestId = [string]$graphError.error.innerError.'request-id' }
                if ([string]::IsNullOrWhiteSpace($responseDate) -and $graphError.error.innerError.date) {
                    $innerDate = $graphError.error.innerError.date
                    $responseDate = if ($innerDate -is [DateTime]) { $innerDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') } else { [string]$innerDate }
                }
            } catch { }
        }
        $statusText = if ($statusCode) { [string]$statusCode } else { 'unknown' }
        $diagnostic = "Microsoft Graph request failed: $Method $uri; HTTP $statusText; code: $graphCode; message: $graphMessage"
        if (-not [string]::IsNullOrWhiteSpace($requestId)) { $diagnostic += "; request-id: $requestId" }
        if (-not [string]::IsNullOrWhiteSpace($responseDate)) { $diagnostic += "; response date: $responseDate" }
        $exception = [System.Exception]::new($diagnostic, $_.Exception)
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
let MatchingFailures = EntraIdSignInEvents
| where Timestamp > ago($([int]$definition.searchHorizonHours)h)
| where AccountUpn =~ '$escapedUpn'
| where ApplicationId == '$escapedApplicationId'
| where ErrorCode == 50126
| project Timestamp, ReportId, AccountUpn, ApplicationId, CorrelationId;
MatchingFailures
| join kind=inner (
    MatchingFailures
    | project ClusterWindowStart = Timestamp, AccountUpn, ApplicationId
) on AccountUpn, ApplicationId
| where Timestamp between (ClusterWindowStart .. ClusterWindowStart + $([int]$definition.windowMinutes)m)
| summarize FailureCount = count(), CorrelationIds = make_set(CorrelationId, $([int]$definition.threshold)), ClusterWindowEnd = max(Timestamp), arg_max(Timestamp, ReportId) by AccountUpn, ApplicationId, ClusterWindowStart
| where FailureCount >= $([int]$definition.threshold)
| sort by ClusterWindowEnd desc, ClusterWindowStart desc
| take 1
| project Timestamp, ReportId, AccountUpn, ApplicationId, FailureCount, ClusterWindowStart, ClusterWindowEnd, CorrelationIds
"@.Trim()
$alertTemplate = @{
    title = [string]$definition.displayName
    description = [string]$definition.description
    severity = [string]$definition.severity
    category = [string]$definition.category
    recommendedActions = 'Review the related sign-in activity.'
    entityMappings = @{
        accounts = @(
            @{ upnColumn = 'AccountUpn' }
        )
    }
}
$rule = @{
    '@odata.type' = '#microsoft.graph.security.detectionRule'
    id = [string]$definition.id
    displayName = [string]$definition.displayName
    description = [string]$definition.description
    status = 'enabled'
    queryCondition = @{ queryText = $query }
    schedule = @{ frequency = [string]$definition.frequency }
    detectionAction = @{
        alertTemplate = $alertTemplate
    }
}
$path = "/security/rules/detectionRules/$([Uri]::EscapeDataString([string]$definition.id))"

function Get-RuleActionCount {
    param($DetectionRule, [string]$PropertyName)
    $actions = $DetectionRule.detectionAction.$PropertyName
    return Get-PopulatedActionValueCount -Value $actions
}

function Get-PopulatedActionValueCount {
    param($Value)

    if ($null -eq $Value) { return 0 }
    if ($Value -is [string]) {
        if ([string]::IsNullOrWhiteSpace($Value)) { return 0 }
        return 1
    }
    if ($Value -is [System.ValueType]) { return 1 }

    if ($Value -is [System.Collections.IDictionary]) {
        return @($Value.Values | ForEach-Object { Get-PopulatedActionValueCount -Value $_ } | Measure-Object -Sum).Sum
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        return @($Value | ForEach-Object { Get-PopulatedActionValueCount -Value $_ } | Measure-Object -Sum).Sum
    }

    $properties = @($Value.psobject.Properties | Where-Object { $_.MemberType -in @('NoteProperty', 'Property') })
    if ($properties.Count -eq 0) { return 0 }
    return @($properties | ForEach-Object { Get-PopulatedActionValueCount -Value $_.Value } | Measure-Object -Sum).Sum
}

function Test-RuleNeedsRepair {
    param($ExistingRule)
    if ($ExistingRule.displayName -ne $rule.displayName -or $ExistingRule.description -ne $rule.description) { return $true }
    if ($ExistingRule.queryCondition.queryText -ne $query) { return $true }
    if ($ExistingRule.schedule.frequency -ne $rule.schedule.frequency) { return $true }
    if (@($ExistingRule.detectionAction.alertTemplate.entityMappings.accounts).Count -ne 1 -or $ExistingRule.detectionAction.alertTemplate.entityMappings.accounts[0].upnColumn -ne 'AccountUpn') { return $true }
    if ((Get-RuleActionCount -DetectionRule $ExistingRule -PropertyName 'automatedActions') -gt 0) { return $true }
    if ((Get-RuleActionCount -DetectionRule $ExistingRule -PropertyName 'responseActions') -gt 0) { return $true }
    return $false
}

function Assert-AlertOnlyRule {
    param($VerifiedRule, [string]$ExpectedStatus)
    if ($VerifiedRule.status -ne $ExpectedStatus) { throw "Custom detection '$($definition.id)' was not $ExpectedStatus." }
    if ($ExpectedStatus -eq 'enabled' -and $VerifiedRule.queryCondition.queryText -ne $query) { throw "Custom detection '$($definition.id)' query verification failed." }
    if ((Get-RuleActionCount -DetectionRule $VerifiedRule -PropertyName 'automatedActions') -gt 0 -or (Get-RuleActionCount -DetectionRule $VerifiedRule -PropertyName 'responseActions') -gt 0) {
        throw "Custom detection '$($definition.id)' unexpectedly contains a remediation action."
    }
}

$existing = $null
try {
    $existing = Invoke-Graph -Method GET -Path $path -ApiVersion beta
} catch {
    if ((Get-GraphStatusCode -ErrorRecord $_) -ne 404) { throw }
    Invoke-Graph -Method POST -Path '/security/rules/detectionRules' -Body $rule -ApiVersion beta | Out-Null
    $verified = Invoke-Graph -Method GET -Path $path -ApiVersion beta
    Assert-AlertOnlyRule -VerifiedRule $verified -ExpectedStatus 'enabled'
    Write-Output "Custom detection '$($definition.displayName)' created and enabled for $userPrincipalName through '$($baseline.failedSignInLab.applicationDisplayName)'. The rule is alert-only with no automated remediation and is eligible for Defender's normal immediate first evaluation."
    return
}

switch ([string]$existing.status) {
    'enabled' {
        Invoke-Graph -Method PATCH -Path $path -Body @{ status = 'disabled' } -ApiVersion beta | Out-Null
        $verified = Invoke-Graph -Method GET -Path $path -ApiVersion beta
        Assert-AlertOnlyRule -VerifiedRule $verified -ExpectedStatus 'disabled'
        Write-Output "Custom detection '$($definition.displayName)' disabled. The rule remains alert-only with no automated remediation."
        return
    }
    'autoDisabled' {
        $lastRun = $existing.lastRunDetails
        $lastRunSummary = if ($null -eq $lastRun) { 'Defender did not return last-run details.' } else { "Last run: $($lastRun.lastRunDateTime); status: $($lastRun.status); error: $($lastRun.errorCode); reason: $($lastRun.failureReason)" }
        Write-Output "Custom detection '$($definition.displayName)' is auto-disabled by Defender and was left unchanged. $lastRunSummary Review the rule before enabling it again."
        return
    }
    'disabled' {
        $needsRepair = Test-RuleNeedsRepair -ExistingRule $existing
        if ($needsRepair) {
            $repairRule = $rule.Clone()
            $repairRule.Remove('@odata.type')
            $repairRule.Remove('id')
            Invoke-Graph -Method PATCH -Path $path -Body $repairRule -ApiVersion beta | Out-Null
        } else {
            Invoke-Graph -Method PATCH -Path $path -Body @{ status = 'enabled' } -ApiVersion beta | Out-Null
        }
        $verified = Invoke-Graph -Method GET -Path $path -ApiVersion beta
        Assert-AlertOnlyRule -VerifiedRule $verified -ExpectedStatus 'enabled'
        $outcome = if ($needsRepair) { 'repaired and enabled' } else { 'enabled' }
        Write-Output "Custom detection '$($definition.displayName)' $outcome for $userPrincipalName through '$($baseline.failedSignInLab.applicationDisplayName)'. The rule is alert-only with no automated remediation. Defender will evaluate the re-enabled rule on its hourly schedule."
        return
    }
    default {
        throw "Custom detection '$($definition.displayName)' has unsupported status '$($existing.status)' and was left unchanged."
    }
}
