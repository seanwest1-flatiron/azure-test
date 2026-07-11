#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string] $GraphAccessToken
)

$ErrorActionPreference = 'Stop'
$sender = 'kobe@corywest.onmicrosoft.com'
$recipient = 'test-customer-data@mailinator.com'
$csv = @'
CustomerId,CustomerName,CardNumber,ExpirationDate,RefundAmount,Currency
C-10041,Avery Carter,4111111111111111,12/2030,125.40,USD
C-10042,Jordan Rivera,5555555555554444,08/2031,89.99,USD
C-10043,Casey Nguyen,378282246310005,11/2030,250.00,USD
C-10044,Morgan Patel,6011111111111117,05/2032,47.25,USD
C-10045,Riley Chen,4000056655665556,09/2031,315.60,USD
C-10046,Taylor Brooks,3530111333300000,03/2032,72.15,USD
'@.Trim()

$attachmentBytes = [Text.Encoding]::UTF8.GetBytes($csv)
$message = @{
    subject = 'Refund register – March'
    body = @{
        contentType = 'Text'
        content = 'Attached is the requested customer payment refund register for reconciliation.'
    }
    toRecipients = @(
        @{ emailAddress = @{ address = $recipient } }
    )
    attachments = @(
        @{
            '@odata.type' = '#microsoft.graph.fileAttachment'
            name = 'customer-payment-refunds-march.csv'
            contentType = 'text/csv'
            contentBytes = [Convert]::ToBase64String($attachmentBytes)
        }
    )
}

Invoke-RestMethod `
    -Method POST `
    -Uri ('https://graph.microsoft.com/v1.0/users/{0}/sendMail' -f [Uri]::EscapeDataString($sender)) `
    -Headers @{ Authorization = "Bearer $GraphAccessToken" } `
    -ContentType 'application/json' `
    -Body (@{ message = $message; saveToSentItems = $true } | ConvertTo-Json -Depth 12)

Write-Output 'Customer payment export accepted by Microsoft Graph for delivery.'
