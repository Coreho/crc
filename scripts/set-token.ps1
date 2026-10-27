# Saves your Claude token as the CLAUDE_CODE_OAUTH_TOKEN secret in every repository that has the
# crc review workflow. Run it in your own terminal after `claude setup-token`, and again when the
# token expires. Pass -Repo owner/name to limit it to specific repositories, or -WhatIf to see
# which repositories it would update.
[CmdletBinding(SupportsShouldProcess)]
param([string[]]$Repo)

$workflow = '.github/workflows/crc-review.yml'

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

$secure = Read-Host "Paste the token from 'claude setup-token'" -AsSecureString
$token = [System.Net.NetworkCredential]::new('', $secure).Password.Trim()
if (-not $token.StartsWith('sk-ant-')) { Write-Host "That doesn't look like a Claude token (it should start with sk-ant-)."; exit 1 }

$failed = @()
foreach ($r in $Repo) {
  # Piped through stdin so the token never appears on a command line.
  $token | gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo $r
  if ($LASTEXITCODE -ne 0) { $failed += $r }
}

if ($failed) { Write-Host "Failed for: $($failed -join ', ')"; exit 1 }
Write-Host "Done. The token is set in all $($Repo.Count) repositories."
