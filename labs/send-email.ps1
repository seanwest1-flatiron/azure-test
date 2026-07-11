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
        subject = 'After Party cybersecurity lab'
        body = @{
            contentType = 'Text'
            content = 'This message was sent by the After Party Azure Automation lab runner.'
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
