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
    @{ Name = 'Routine'; Count = 60; SubjectPrefix = '[After Party routine]'; Body = 'This is a benign routine-message exercise.' },
    @{ Name = 'Junk training'; Count = 25; SubjectPrefix = '[After Party junk training]'; Body = 'This is a benign junk-classification exercise. Move it to Junk manually if assigned for triage practice; do not use Report junk because that can block the sender.' },
    @{ Name = 'Phishing reporting training'; Count = 15; SubjectPrefix = '[After Party phishing reporting training]'; Body = "This is a benign phishing-reporting exercise. It contains no credential request and no live phishing destination. The safe Microsoft Learn reporting guide is: $reportingGuide" }
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
        $importance = if ($scenario.Name -eq 'Phishing reporting training') { 'high' } else { 'normal' }
        $message = @{
            subject = '{0} {1:D3} [{2}]' -f $scenario.SubjectPrefix, $sequence, $batchId
            importance = $importance
            body = @{ contentType = 'Text'; content = "$($scenario.Body)`n`nBatch: $batchId`nMessage: $sequence of 100" }
            toRecipients = @(@{ emailAddress = @{ address = $recipient } })
            internetMessageHeaders = @(
                @{ name = 'x-after-party-lab'; value = 'email-triage-simulation' },
                @{ name = 'x-after-party-batch'; value = $batchId },
                @{ name = 'x-after-party-scenario'; value = $scenario.Name }
            )
        }

        if ($sequence % 10 -eq 0) {
            $attachmentText = "Harmless text attachment for After Party message $sequence in batch $batchId."
            $message.attachments = @(
                @{
                    '@odata.type' = '#microsoft.graph.fileAttachment'
                    name = "after-party-training-$sequence.txt"
                    contentType = 'text/plain'
                    contentBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($attachmentText))
                }
            )
        }

        Send-GraphMailWithRetry -Sender $sender -Message $message -Headers $headers
        if ($sequence % 10 -eq 0) { Write-Output "Accepted $sequence of 100 training messages." }
    }
}

Write-Output "Triage simulation complete. Batch ID: $batchId"
Write-Output 'Have Kobe or Cory manually use Outlook Report phishing on selected phishing-reporting training messages to create real user-report telemetry.'
