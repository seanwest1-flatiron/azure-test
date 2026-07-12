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
            Write-Output "Waiting for Microsoft Graph directory changes before retrying $Method $Path."
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
            surname = $SeedUser.surname
            jobTitle = $SeedUser.jobTitle
            department = $SeedUser.department
            usageLocation = 'US'
        }
        Invoke-Graph -Method PATCH -Path "/users/$($user.id)" -Body $profile | Out-Null
        return @{ User = $user; Created = $false }
    } catch {
        if ((Get-GraphStatusCode -ErrorRecord $_) -ne 404) { throw }
    }

    $newUser = Invoke-Graph -Method POST -Path '/users' -Body @{
        accountEnabled = $true
        displayName = $SeedUser.displayName
        givenName = $SeedUser.givenName
        surname = $SeedUser.surname
        jobTitle = $SeedUser.jobTitle
        department = $SeedUser.department
        usageLocation = 'US'
        mailNickname = $SeedUser.mailNickname
        userPrincipalName = $SeedUser.userPrincipalName
        passwordProfile = @{ password = (New-TemporaryPassword); forceChangePasswordNextSignIn = $true }
    }
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

$licenses = @((Resolve-License -License $seed.licenses.businessPremium))
$combinedLicense = Resolve-License -License $seed.licenses.combinedDefenderAndPurview -Optional
if ($null -ne $combinedLicense) {
    $licenses += $combinedLicense
    Write-Output "Using combined Defender and Purview license SKU."
} else {
    $licenses += Resolve-License -License $seed.licenses.defender
    $licenses += Resolve-License -License $seed.licenses.purview
    Write-Output "Using separate Defender and Purview license SKUs."
}

$group = $null
foreach ($displayName in @($seed.group.displayName) + @($seed.group.legacyDisplayNames)) {
    $groupFilter = [Uri]::EscapeDataString("displayName eq '$displayName'")
    $groups = (Invoke-Graph -Method GET -Path "/groups?`$filter=$groupFilter&`$select=id,displayName,assignedLicenses").value
    $group = $groups | Select-Object -First 1
    if ($group) { break }
}
if (-not $group) {
    $group = Invoke-Graph -Method POST -Path '/groups' -Body @{
        displayName = $seed.group.displayName
        mailEnabled = $false
        mailNickname = $seed.group.mailNickname
        securityEnabled = $true
    }
    Write-Output "Created group: $($group.displayName)"
} else {
    if ($group.displayName -ne $seed.group.displayName) {
        Invoke-Graph -Method PATCH -Path "/groups/$($group.id)" -Body @{ displayName = $seed.group.displayName } | Out-Null
        $group.displayName = $seed.group.displayName
        Write-Output "Renamed existing group to: $($group.displayName)"
    }
    Write-Output "Reusing group: $($group.displayName)"
}

$existingLicenseIds = @($group.assignedLicenses | ForEach-Object skuId)
$missingLicenses = @($licenses | Where-Object { $existingLicenseIds -notcontains $_.skuId })
if ($missingLicenses.Count -gt 0) {
    Invoke-GraphWithRetry -Method POST -Path "/groups/$($group.id)/assignLicense" -Body @{ addLicenses = $missingLicenses; removeLicenses = @() } | Out-Null
    Write-Output "Assigned $($missingLicenses.Count) license SKU(s) to $($group.displayName)."
} else {
    Write-Output 'All requested license SKUs are already assigned to the group.'
}

$memberIds = @((Invoke-Graph -Method GET -Path "/groups/$($group.id)/members?`$select=id").value | ForEach-Object id)
$created = 0
$reused = 0
foreach ($seedUser in $seed.users) {
    $result = Get-SeedUser -SeedUser $seedUser
    if ($result.Created) { $created += 1 } else { $reused += 1 }
    if ($memberIds -notcontains $result.User.id) {
        try {
            Invoke-GraphWithRetry -Method POST -Path "/groups/$($group.id)/members/`$ref" -Body @{ '@odata.id' = "https://graph.microsoft.com/v1.0/directoryObjects/$($result.User.id)" } | Out-Null
        } catch {
            if ((Get-GraphStatusCode -ErrorRecord $_) -ne 400 -or $_.Exception.Message -notmatch 'already exist') { throw }
        }
    }
}

Write-Output "Tenant seed complete. Created: $created. Reused: $reused. Group members: $($seed.users.Count)."
