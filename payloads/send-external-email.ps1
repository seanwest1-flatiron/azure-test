#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$sender = 'kobe@corywest.onmicrosoft.com'
$recipient = 'jonk9980@gmail.com'
$message = @{
    message = @{
        subject = 'Status update'
        body = @{
            contentType = 'Text'
            content = 'Please let me know if you have any questions.'
        }
        toRecipients = @(
            @{ emailAddress = @{ address = $recipient } }
        )
    }
    saveToSentItems = $true
}

Invoke-RestMethod `
    -Method POST `
    -Uri ("https://graph.microsoft.com/v1.0/users/$sender/sendMail") `
    -Headers @{ Authorization = "Bearer $GraphAccessToken" } `
    -ContentType 'application/json' `
    -Body ($message | ConvertTo-Json -Depth 8)

Write-Output "Email accepted by Microsoft Graph for delivery from $sender to $recipient."
