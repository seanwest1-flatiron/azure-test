#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$owner = 'kobe@corywest.onmicrosoft.com'
$recipient = 'cory@corywest.onmicrosoft.com'
$fileName = 'AfterParty-OneDrive-Share-{0}.txt' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
$fileContent = "After Party OneDrive sharing lab created this file at $(Get-Date -Format o)."
$ownerPath = [Uri]::EscapeDataString($owner)
$uploadUri = 'https://graph.microsoft.com/v1.0/users/{0}/drive/root:/{1}:/content' -f $ownerPath, $fileName
$headers = @{ Authorization = "Bearer $GraphAccessToken" }

Write-Output "Creating $fileName in $owner's OneDrive."
$driveItem = Invoke-RestMethod `
    -Method PUT `
    -Uri $uploadUri `
    -Headers $headers `
    -ContentType 'text/plain; charset=utf-8' `
    -Body $fileContent

if ([string]::IsNullOrWhiteSpace($driveItem.id)) {
    throw 'Microsoft Graph did not return the created OneDrive item ID.'
}

$inviteUri = 'https://graph.microsoft.com/v1.0/users/{0}/drive/items/{1}/invite' -f $ownerPath, [Uri]::EscapeDataString($driveItem.id)
$invitation = @{
    recipients = @(
        @{ email = $recipient }
    )
    message = 'After Party lab: this text file was shared with you from Kobe''s OneDrive.'
    requireSignIn = $true
    sendInvitation = $true
    roles = @('read')
}

Write-Output "Granting $recipient read access and sending the sharing invitation."
Invoke-RestMethod `
    -Method POST `
    -Uri $inviteUri `
    -Headers $headers `
    -ContentType 'application/json' `
    -Body ($invitation | ConvertTo-Json -Depth 8)

Write-Output "Shared $fileName from $owner to $recipient."
