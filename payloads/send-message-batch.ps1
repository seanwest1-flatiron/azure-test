#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$users = @('kobe@corywest.onmicrosoft.com', 'cory@corywest.onmicrosoft.com')
$batchId = [Guid]::NewGuid().ToString()
$reportingGuide = 'https://learn.microsoft.com/en-us/defender-office-365/submissions-outlook-report-messages'
$scenarios = @(
    @{ Name = 'Correspondence'; Count = 60; SubjectPrefix = 'Quarterly account update'; Body = 'Please review the account update and reply if anything needs correction.' },
    @{ Name = 'Nonessential'; Count = 25; SubjectPrefix = 'Subscription and service notice'; Body = 'This message contains an informational service notice.' },
    @{ Name = 'Account notice'; Count = 15; SubjectPrefix = 'Action required: account review'; Body = "Please review the account information at $reportingGuide" }
)

function Send-GraphMailWithRetry {
    param(
        [Parameter(Mandatory)] [string] $Sender,
        [Parameter(Mandatory)] [hashtable] $Message,
        [Parameter(Mandatory)] [hashtable] $Headers
    )

    $uri = 'https://graph.microsoft.com/v1.0/users/{0}/sendMail' -f [Uri]::EscapeDataString($Sender)
    $body = @{ message = $Message; saveToSentItems = $true } | ConvertTo-Json -Depth 12
    for ($attempt = 1; $attempt -le 4; $attempt += 1) {
        try {
            Invoke-RestMethod -Method POST -Uri $uri -Headers $Headers -ContentType 'application/json' -Body $body
            return
        } catch {
            $statusCode = $_.Exception.Response.StatusCode.value__
            if ($statusCode -ne 429 -or $attempt -eq 4) { throw }
            Start-Sleep -Seconds (5 * $attempt)
        }
    }
}

$headers = @{ Authorization = "Bearer $GraphAccessToken" }
$sequence = 0
foreach ($scenario in $scenarios) {
    for ($index = 1; $index -le $scenario.Count; $index += 1) {
        $sequence += 1
        $sender = $users[($sequence - 1) % $users.Count]
        $recipient = $users[$sequence % $users.Count]
        $importance = if ($scenario.Name -eq 'Account notice') { 'high' } else { 'normal' }
        $message = @{
            subject = '{0} {1:D3} [{2}]' -f $scenario.SubjectPrefix, $sequence, $batchId
            importance = $importance
            body = @{ contentType = 'Text'; content = "$($scenario.Body)`n`nBatch: $batchId`nMessage: $sequence of 100" }
            toRecipients = @(@{ emailAddress = @{ address = $recipient } })
            internetMessageHeaders = @(
                @{ name = 'x-after-party-workflow'; value = 'message-batch' },
                @{ name = 'x-after-party-batch'; value = $batchId },
                @{ name = 'x-after-party-scenario'; value = $scenario.Name }
            )
        }

        if ($sequence % 10 -eq 0) {
            $attachmentText = "Harmless text attachment for After Party message $sequence in batch $batchId."
            $message.attachments = @(
                @{
                    '@odata.type' = '#microsoft.graph.fileAttachment'
                    name = "supporting-document-$sequence.txt"
                    contentType = 'text/plain'
                    contentBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($attachmentText))
                }
            )
        }

        Send-GraphMailWithRetry -Sender $sender -Message $message -Headers $headers
        if ($sequence % 10 -eq 0) { Write-Output "Accepted $sequence of 100 messages." }
    }
}

Write-Output "Message batch complete. Batch ID: $batchId"
