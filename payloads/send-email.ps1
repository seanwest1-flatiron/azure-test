#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$sender = 'kobe@corywest.onmicrosoft.com'
$recipient = 'cory@corywest.onmicrosoft.com'
$sendMailUri = "https://graph.microsoft.com/v1.0/users/$sender/sendMail"
$message = @{
    message = @{
        subject = 'Invoice reconciliation request'
        body = @{
            contentType = 'Text'
            content = 'Please review the attached reconciliation request and reply with any questions.'
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
