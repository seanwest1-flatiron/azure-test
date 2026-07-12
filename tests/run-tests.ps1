[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$pester = Get-Module -ListAvailable Pester | Sort-Object Version -Descending | Select-Object -First 1
if (-not $pester) { throw 'Pester is required. Install it with: Install-Module Pester -Scope CurrentUser' }
if ($pester.Version.Major -lt 5) { throw 'Pester 5 or newer is required. Install it with: Install-Module Pester -Scope CurrentUser -Force -SkipPublisherCheck -MinimumVersion 5.5.0' }
Import-Module $pester.Path -Force

$pesterTests = Get-ChildItem -Path $PSScriptRoot -Filter '*.Tests.ps1'
$result = Invoke-Pester -Path $pesterTests.FullName -Output Detailed -PassThru
if ($result.FailedCount -gt 0) { throw "$($result.FailedCount) PowerShell test(s) failed." }

& node --test (Join-Path $PSScriptRoot 'automation-client.test.mjs')
if ($LASTEXITCODE -ne 0) { throw 'JavaScript tests failed.' }
