# Saves your Claude token as the CLAUDE_CODE_OAUTH_TOKEN secret in every repository that has the
# crc review workflow. Run it in your own terminal after `claude setup-token`, and again when the
# token expires. Pass -Repo owner/name to limit it to specific repositories, or -WhatIf to see
# which repositories it would update.
#
# To run it without pasting the token each time, save the token once with -Save. It's stored in
# %APPDATA%\crc\token.xml, encrypted with Windows DPAPI so only your Windows account can read it.
# After that, -Stored reads the token from there instead of asking, so the script can run
# unattended (for example right after the workflow is added to a new repository).
[CmdletBinding(SupportsShouldProcess)]
param(
  [string[]]$Repo,
  # Read the token saved with -Save instead of asking for it.
  [switch]$Stored,
  # Ask for the token, save it for -Stored, and exit without setting any secrets.
  [switch]$Save
)

$workflow = '.github/workflows/crc-review.yml'
$tokenFile = Join-Path $env:APPDATA 'crc\token.xml'

function Test-Token([string]$t) {
  if ($t.StartsWith('sk-ant-')) { return $true }
  Write-Host "That doesn't look like a Claude token (it should start with sk-ant-)."
  return $false
}

if ($Save) {
  $secure = Read-Host "Paste the token from 'claude setup-token'" -AsSecureString
  if (-not (Test-Token ([System.Net.NetworkCredential]::new('', $secure).Password.Trim()))) { exit 1 }
  New-Item -ItemType Directory -Force (Split-Path $tokenFile) | Out-Null
  $secure | Export-Clixml $tokenFile
  Write-Host "Saved to $tokenFile. Run with -Stored to use it."
  exit 0
}

if ($Stored -and -not (Test-Path $tokenFile)) {
  Write-Host "No saved token at $tokenFile. Save one first with: scripts/set-token.ps1 -Save"
  exit 1
}

if (-not $Repo) {
  # Your own repositories, plus those of organizations where you're an admin. Forks and archived
  # repositories are left out, as are repositories without the workflow.
  $owners = @(gh api user --jq .login) + @(gh api user/memberships/orgs --jq '.[] | select(.role == "admin") | .organization.login')
  $candidates = foreach ($owner in $owners) {
    gh repo list $owner --limit 1000 --source --no-archived --json nameWithOwner --jq '.[].nameWithOwner'
  }
  $Repo = foreach ($r in $candidates) {
    gh api "repos/$r/contents/$workflow" --silent 2>$null
    if ($LASTEXITCODE -eq 0) { $r }
  }
}

if (-not $Repo) { Write-Host 'No repositories have the crc workflow.'; exit 1 }
Write-Host "$($Repo.Count) repositories: $($Repo -join ', ')"
if (-not $PSCmdlet.ShouldProcess("$($Repo.Count) repositories", 'Set CLAUDE_CODE_OAUTH_TOKEN')) { exit 0 }

$secure = if ($Stored) { Import-Clixml $tokenFile } else { Read-Host "Paste the token from 'claude setup-token'" -AsSecureString }
$token = [System.Net.NetworkCredential]::new('', $secure).Password.Trim()
if (-not (Test-Token $token)) { exit 1 }

$failed = @()
foreach ($r in $Repo) {
  # Piped through stdin so the token never appears on a command line.
  $token | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $r
  if ($LASTEXITCODE -ne 0) { $failed += $r }
}

if ($failed) { Write-Host "Failed for: $($failed -join ', ')"; exit 1 }
Write-Host "Done. The token is set in all $($Repo.Count) repositories."
