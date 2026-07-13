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
$seedUri = "$repositoryBase/payloads/tenant-seed.json?version=$([Uri]::EscapeDataString([string]$manifest.payloadVersion))"
$seed = Invoke-RestMethod -Method GET -Uri $seedUri
$headers = @{ Authorization = "Bearer $GraphAccessToken" }

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
        $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedPayload))
        $payload = $payloadJson | ConvertFrom-Json
    } catch {
        throw 'The managed identity Graph access token payload could not be decoded.'
    }
    return @($payload.roles | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | Sort-Object -Unique)
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
    param([string] $Method, [string] $Path, $Body)
    $uri = "https://graph.microsoft.com/v1.0$Path"
    $parameters = @{ Method = $Method; Uri = $uri; Headers = $headers }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $parameters.ContentType = 'application/json'
        $parameters.Body = $Body | ConvertTo-Json -Depth 12
    }
    try {
        Invoke-RestMethod @parameters
    } catch {
        $statusCode = Get-GraphStatusCode -ErrorRecord $_
        $errorBody = $_.ErrorDetails.Message
        if ([string]::IsNullOrWhiteSpace([string]$errorBody) -and $null -ne $_.Exception.Response) {
            try {
                $responseStream = $_.Exception.Response.GetResponseStream()
                if ($null -ne $responseStream) {
                    $reader = [IO.StreamReader]::new($responseStream)
                    try { $errorBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
                }
            } catch { }
        }
        $graphCode = 'Unknown'
        $graphMessage = $_.Exception.Message
        if (-not [string]::IsNullOrWhiteSpace([string]$errorBody)) {
            try {
                $graphError = $errorBody | ConvertFrom-Json
                if (-not [string]::IsNullOrWhiteSpace([string]$graphError.error.code)) { $graphCode = [string]$graphError.error.code }
                if (-not [string]::IsNullOrWhiteSpace([string]$graphError.error.message)) { $graphMessage = [string]$graphError.error.message }
            } catch { }
        }
        $statusText = if ($statusCode) { [string]$statusCode } else { 'unknown' }
        $detail = "Microsoft Graph request failed: $Method $uri; HTTP $statusText; code: $graphCode; message: $graphMessage"
        $exception = [System.Exception]::new($detail, $_.Exception)
        if ($statusCode) { $exception.Data['StatusCode'] = $statusCode }
        throw $exception
    }
}

function Invoke-GraphWithRetry {
    param(
        [string] $Method,
        [string] $Path,
        $Body,
        [int[]] $RetryStatusCodes = @(404),
        [int] $MaximumAttempts = 15
    )
    $parameters = @{ Method = $Method; Path = $Path }
    if ($PSBoundParameters.ContainsKey('Body')) { $parameters.Body = $Body }
    for ($attempt = 1; $attempt -le $MaximumAttempts; $attempt += 1) {
        try {
            return Invoke-Graph @parameters
        } catch {
            $statusCode = Get-GraphStatusCode -ErrorRecord $_
            if ($RetryStatusCodes -notcontains $statusCode -or $attempt -eq $MaximumAttempts) { throw }
            Write-Verbose "Waiting for Microsoft Graph directory changes before retrying $Method $Path."
            Start-Sleep -Seconds 2
        }
    }
}

$tokenRoles = @(Get-AccessTokenRoles -AccessToken $GraphAccessToken)
Write-Output "Managed identity Graph roles: $(if ($tokenRoles.Count) { $tokenRoles -join ', ' } else { '(none)' })"

function New-TemporaryPassword {
    $characters = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    $random = -join (1..24 | ForEach-Object { $characters[(Get-Random -Maximum $characters.Length)] })
    "Ap!$random`9z"
}

function Get-SeedUser {
    param($SeedUser)
    try {
        $user = Invoke-Graph -Method GET -Path "/users/$([Uri]::EscapeDataString($SeedUser.userPrincipalName))?`$select=id,userPrincipalName"
        $profile = @{
            displayName = $SeedUser.displayName
            givenName = $SeedUser.givenName
            jobTitle = $SeedUser.jobTitle
            department = $SeedUser.department
            usageLocation = 'US'
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$SeedUser.surname)) { $profile.surname = $SeedUser.surname }
        Invoke-Graph -Method PATCH -Path "/users/$($user.id)" -Body $profile | Out-Null
        return @{ User = $user; Created = $false }
    } catch {
        if ((Get-GraphStatusCode -ErrorRecord $_) -ne 404) { throw }
    }

    $newUserProperties = @{
        accountEnabled = $true
        displayName = $SeedUser.displayName
        givenName = $SeedUser.givenName
        jobTitle = $SeedUser.jobTitle
        department = $SeedUser.department
        usageLocation = 'US'
        mailNickname = $SeedUser.mailNickname
        userPrincipalName = $SeedUser.userPrincipalName
        passwordProfile = @{ password = (New-TemporaryPassword); forceChangePasswordNextSignIn = $true }
    }
    if (-not [string]::IsNullOrWhiteSpace([string]$SeedUser.surname)) { $newUserProperties.surname = $SeedUser.surname }
    $newUser = Invoke-Graph -Method POST -Path '/users' -Body $newUserProperties
    return @{ User = $newUser; Created = $true }
}

$skus = (Invoke-Graph -Method GET -Path '/subscribedSkus').value
function Resolve-License {
    param($License, [switch]$Optional)
    $sku = $skus | Where-Object { $License.skuPartNumberCandidates -contains $_.skuPartNumber } | Select-Object -First 1
    if (-not $sku) {
        if ($Optional) { return $null }
        $available = ($skus | ForEach-Object skuPartNumber) -join ', '
        throw "Required license '$($License.displayName)' was not found. Available SKU part numbers: $available"
    }
    return @{ skuId = $sku.skuId; disabledPlans = @() }
}

function Get-BaselineGroup {
    param($Definition, [switch] $Microsoft365)
    $select = 'id,displayName,description,mailNickname,mailEnabled,securityEnabled,groupTypes,visibility,assignedLicenses'
    $escapedMailNickname = [string]$Definition.mailNickname -replace "'", "''"
    $filter = [Uri]::EscapeDataString("mailNickname eq '$escapedMailNickname'")
    $group = @((Invoke-Graph -Method GET -Path "/groups?`$filter=$filter&`$select=$select").value) | Select-Object -First 1
    if (-not $group) {
        foreach ($displayName in @($Definition.displayName) + @($Definition.legacyDisplayNames)) {
            $escapedDisplayName = [string]$displayName -replace "'", "''"
            $filter = [Uri]::EscapeDataString("displayName eq '$escapedDisplayName'")
            $group = @((Invoke-Graph -Method GET -Path "/groups?`$filter=$filter&`$select=$select").value) | Select-Object -First 1
            if ($group) { break }
        }
    }

    if (-not $group) {
        $properties = @{
            displayName = $Definition.displayName
            mailNickname = $Definition.mailNickname
            mailEnabled = [bool]$Microsoft365
            securityEnabled = -not [bool]$Microsoft365
        }
        if ($Microsoft365) {
            $properties.groupTypes = @('Unified')
            $properties.visibility = 'Private'
            $properties.description = $Definition.description
        }
        $group = Invoke-Graph -Method POST -Path '/groups' -Body $properties
        return [pscustomobject]@{ Group = $group; Created = $true; Repaired = $false }
    }

    $isMicrosoft365 = @($group.groupTypes) -contains 'Unified'
    if ([bool]$Microsoft365 -ne $isMicrosoft365) {
        $expectedType = if ($Microsoft365) { 'Microsoft 365' } else { 'security' }
        throw "Baseline group '$($Definition.displayName)' exists with mail nickname '$($Definition.mailNickname)' but is not a $expectedType group."
    }

    $updates = @{}
    if ($group.displayName -ne $Definition.displayName) { $updates.displayName = $Definition.displayName }
    if ($group.mailNickname -ne $Definition.mailNickname) { $updates.mailNickname = $Definition.mailNickname }
    if ($Microsoft365 -and $group.description -ne $Definition.description) { $updates.description = $Definition.description }
    if ($Microsoft365 -and $group.visibility -ne 'Private') { $updates.visibility = 'Private' }
    if ($Microsoft365 -and $group.securityEnabled) { $updates.securityEnabled = $false }
    if ($updates.Count) {
        Invoke-Graph -Method PATCH -Path "/groups/$($group.id)" -Body $updates | Out-Null
        foreach ($key in $updates.Keys) { $group.$key = $updates[$key] }
    }
    return [pscustomobject]@{ Group = $group; Created = $false; Repaired = [bool]$updates.Count }
}

function Confirm-GroupMembership {
    param([string] $GroupId, [string[]] $ExpectedUserIds)
    $members = (Invoke-GraphWithRetry -Method GET -Path "/groups/$GroupId/members?`$select=id").value
    $memberIds = @($members | ForEach-Object { [string]$_.id })
    $missingUserIds = @($ExpectedUserIds | Where-Object { $memberIds -notcontains $_ })
    foreach ($userId in $missingUserIds) {
        try {
            Invoke-GraphWithRetry -Method POST -Path "/groups/$GroupId/members/`$ref" -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$userId" } | Out-Null
        } catch {
            if ((Get-GraphStatusCode -ErrorRecord $_) -ne 400 -or $_.Exception.Message -notmatch 'already exist') { throw }
        }
    }
    for ($attempt = 1; $attempt -le 15; $attempt += 1) {
        $verifiedIds = @((Invoke-GraphWithRetry -Method GET -Path "/groups/$GroupId/members?`$select=id").value | ForEach-Object { [string]$_.id })
        $unverifiedIds = @($ExpectedUserIds | Where-Object { $verifiedIds -notcontains $_ })
        if (-not $unverifiedIds.Count) {
            return [pscustomobject]@{ Added = $missingUserIds.Count; Verified = $ExpectedUserIds.Count }
        }
        if ($attempt -eq 15) { throw "Microsoft Graph did not confirm $($unverifiedIds.Count) expected member(s) for group $GroupId." }
        Start-Sleep -Seconds 2
    }
}

function ConvertTo-SettingValues {
    param($Values)
    return @($Values | ForEach-Object { @{ name = [string]$_.name; value = [string]$_.value } })
}

function Set-PasswordRuleSettings {
    param($Definition)
    $settings = @((Invoke-Graph -Method GET -Path '/groupSettings').value)
    $setting = @($settings | Where-Object { [string]$_.templateId -eq [string]$Definition.templateId }) | Select-Object -First 1
    if ($setting) {
        $values = @{}
        foreach ($value in $setting.values) { $values[[string]$value.name] = [string]$value.value }
    } else {
        $template = Invoke-Graph -Method GET -Path "/groupSettingTemplates/$([Uri]::EscapeDataString([string]$Definition.templateId))"
        $values = @{}
        foreach ($value in $template.values) { $values[[string]$value.name] = [string]$value.defaultValue }
    }
    foreach ($name in $Definition.values.psobject.Properties.Name) { $values[$name] = [string]$Definition.values.$name }
    $completeValues = @($values.Keys | Sort-Object | ForEach-Object { @{ name = $_; value = $values[$_] } })
    if ($setting) {
        Invoke-Graph -Method PATCH -Path "/groupSettings/$($setting.id)" -Body @{ values = $completeValues } | Out-Null
        $settingId = $setting.id
    } else {
        $created = Invoke-Graph -Method POST -Path '/groupSettings' -Body @{ templateId = [string]$Definition.templateId; values = $completeValues }
        $settingId = $created.id
    }
    $verified = Invoke-Graph -Method GET -Path "/groupSettings/$settingId"
    $verifiedValues = @{}
    foreach ($value in $verified.values) { $verifiedValues[[string]$value.name] = [string]$value.value }
    foreach ($name in $Definition.values.psobject.Properties.Name) {
        if ($verifiedValues[$name] -ne [string]$Definition.values.$name) { throw "Password Rule Settings verification failed for $name." }
    }
    return [pscustomobject]@{ LockoutThreshold = $verifiedValues.LockoutThreshold; LockoutDurationInSeconds = $verifiedValues.LockoutDurationInSeconds }
}

$licenses = @((Resolve-License -License $seed.licenses.businessPremium))
$passwordRules = Set-PasswordRuleSettings -Definition $seed.passwordRuleSettings
$combinedLicense = Resolve-License -License $seed.licenses.combinedDefenderAndPurview -Optional
if ($null -ne $combinedLicense) {
    $licenses += $combinedLicense
    Write-Output "Using combined Defender and Purview license SKU."
} else {
    $licenses += Resolve-License -License $seed.licenses.defender
    $licenses += Resolve-License -License $seed.licenses.purview
    Write-Output "Using separate Defender and Purview license SKUs."
}

$licensingGroupResult = Get-BaselineGroup -Definition $seed.licensingGroup
$licensingGroup = $licensingGroupResult.Group

$existingLicenseIds = @($licensingGroup.assignedLicenses | ForEach-Object skuId)
$missingLicenses = @($licenses | Where-Object { $existingLicenseIds -notcontains $_.skuId })
if ($missingLicenses.Count -gt 0) {
    Invoke-GraphWithRetry -Method POST -Path "/groups/$($licensingGroup.id)/assignLicense" -Body @{ addLicenses = $missingLicenses; removeLicenses = @() } | Out-Null
}

$created = 0
$reused = 0
$baselineUsersByUpn = @{}
foreach ($seedUser in $seed.users) {
    $result = Get-SeedUser -SeedUser $seedUser
    if ($result.Created) { $created += 1 } else { $reused += 1 }
    $baselineUsersByUpn[([string]$seedUser.userPrincipalName).ToLowerInvariant()] = $result.User
}

$allEmployeeIds = @($seed.users | ForEach-Object { [string]$baselineUsersByUpn[([string]$_.userPrincipalName).ToLowerInvariant()].id })
$licensingMembership = Confirm-GroupMembership -GroupId $licensingGroup.id -ExpectedUserIds $allEmployeeIds

$departmentGroupsCreated = 0
$departmentGroupsRepaired = 0
$departmentMembershipsAdded = 0
$departmentMembershipsVerified = 0
foreach ($department in $seed.departments) {
    $departmentGroupResult = Get-BaselineGroup -Definition $department -Microsoft365
    if ($departmentGroupResult.Created) { $departmentGroupsCreated += 1 }
    if ($departmentGroupResult.Repaired) { $departmentGroupsRepaired += 1 }
    $departmentUserIds = foreach ($userPrincipalName in $department.memberUserPrincipalNames) {
        $baselineUser = $baselineUsersByUpn[([string]$userPrincipalName).ToLowerInvariant()]
        if (-not $baselineUser) { throw "Department '$($department.displayName)' references unknown baseline user '$userPrincipalName'." }
        [string]$baselineUser.id
    }
    $membership = Confirm-GroupMembership -GroupId $departmentGroupResult.Group.id -ExpectedUserIds @($departmentUserIds)
    $departmentMembershipsAdded += $membership.Added
    $departmentMembershipsVerified += $membership.Verified
}

Write-Output "Tenant preparation complete. Users: $($seed.users.Count) configured ($created created, $reused repaired). Licensing: $($seed.licensingGroup.displayName) with $($licensingMembership.Verified)/$($seed.users.Count) baseline members and $($licenses.Count) license SKU(s). Departments: $($seed.departments.Count) Microsoft 365 groups ($departmentGroupsCreated created, $departmentGroupsRepaired repaired) with $departmentMembershipsVerified configured memberships ($departmentMembershipsAdded added). Password Rule Settings verified: LockoutThreshold=$($passwordRules.LockoutThreshold), LockoutDurationInSeconds=$($passwordRules.LockoutDurationInSeconds)."
