Describe 'Message batch payload' {
    BeforeAll {
        $payloadPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'payloads/send-message-batch.ps1'
    }

    BeforeEach {
        $global:AfterPartyMessageBatchRequests = @()
        Mock Invoke-RestMethod {
            param($Uri, $Method, $Body)
            if ($Method -eq 'POST' -and $Uri -like 'https://graph.microsoft.com/v1.0/users/*/sendMail') {
                $global:AfterPartyMessageBatchRequests += $Body | ConvertFrom-Json -Depth 12
                return
            }
            throw "Unexpected REST request: $Method $Uri"
        }
    }

    It 'sends ten messages and reports the reduced batch size' {
        $output = & $payloadPath -GraphAccessToken 'graph-token' -TenantDomain 'student.onmicrosoft.com'

        $global:AfterPartyMessageBatchRequests.Count | Should -Be 10
        $output | Should -Contain 'Accepted 10 of 10 messages.'
        ($output -join "`n") | Should -Match 'Message batch complete\. 10 messages accepted\.'
        foreach ($request in $global:AfterPartyMessageBatchRequests) {
            $request.message.body.content | Should -Match 'Message: \d+ of 10'
        }
    }
}
