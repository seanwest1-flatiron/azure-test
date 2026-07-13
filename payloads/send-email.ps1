#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken,
    [Parameter(Mandatory)]
    [string] $TenantDomain
)

$ErrorActionPreference = 'Stop'
$sender = "kobe@$TenantDomain"
$recipient = "cory@$TenantDomain"
$sendMailUri = "https://graph.microsoft.com/v1.0/users/$sender/sendMail"
$message = @{
    message = @{
        subject = 'Invoice reconciliation request'
        body = @{
            contentType = 'Text'
            content = 'Please review the reconciliation request and reply with any questions.'
        }
        toRecipients = @(
            @{ emailAddress = @{ address = $recipient } }
        )
    }
    saveToSentItems = $true
}

Invoke-RestMethod `
    -Method POST `
    -Uri $sendMailUri `
    -Headers @{ Authorization = "Bearer $GraphAccessToken" } `
    -ContentType 'application/json' `
    -Body ($message | ConvertTo-Json -Depth 8)

Write-Output "Email accepted by Microsoft Graph for delivery from $sender to $recipient."
