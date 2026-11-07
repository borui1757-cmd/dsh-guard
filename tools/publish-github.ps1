# Publish claim-verify-wsc to GitHub via REST API (no git required).
#
# Why: this machine has no git/gh installed. The GitHub REST API can create the
# repo and upload every file, which is enough for a first publish.
#
# Usage:
#   $env:GITHUB_TOKEN = 'ghp_xxxxxxxx'        # needs 'repo' scope
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/publish-github.ps1 -Owner <your-login>
#
#   Add -Private for a private repo, -DryRun to only list what would be uploaded.
#
# ASCII only on purpose: Windows PowerShell 5.1 mis-parses UTF-8 CN text and
# silently kills the script before it runs (we hit that once already).

param(
  [string]$Owner = $env:GITHUB_OWNER,
  [string]$RepoName = 'claim-verify-wsc',
  [string]$Token = $env:GITHUB_TOKEN,
  [string]$Description = 'Verify what an AI agent claims about your machine against the real system state. Local ground truth, 14 claim kinds, zero model calls.',
  [switch]$Private,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$api = 'https://api.github.com'

# --- file selection -------------------------------------------------------
$skipDirs = @('node_modules', '.git', '.github' + '\workflows')
$skipFiles = @('.tgz')
$skipRel = @('eval\corpus.jsonl', 'eval/corpus.jsonl')

function Get-Rel($p) { $p.Substring($root.Length + 1) }

$files = @()
foreach ($f in (Get-ChildItem -LiteralPath $root -Recurse -File)) {
  $rel = Get-Rel $f.FullName
  if ($rel -match '\\node_modules\\|\\\.git\\') { continue }
  if ($f.Extension -eq '.tgz') { continue }
  if ($skipRel -contains $rel) { continue }
  $files += [pscustomobject]@{ rel = $rel; full = $f.FullName; size = $f.Length }
}
$files = $files | Sort-Object rel

Write-Host ("Files to upload: {0}" -f $files.Count)
foreach ($f in $files) { Write-Host ("  {0,-40} {1,7} B" -f $f.rel, $f.size) }
Write-Host ("Total: {0:N1} KB" -f (($files | Measure-Object size -Sum).Sum / 1KB))

if ($DryRun) { Write-Host 'DRY RUN: nothing sent.'; exit 0 }

if (-not $Token) { throw 'No token. Set $env:GITHUB_TOKEN (needs repo scope).' }
if (-not $Owner) { throw 'No owner. Pass -Owner <github-login>.' }

$headers = @{
  Authorization          = "Bearer $Token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = 'claim-verify-wsc-publisher'
}

function Invoke-GH {
  param([string]$Method, [string]$Url, $Body)
  $req = @{ Method = $Method; Uri = $Url; Headers = $headers }
  if ($null -ne $Body) {
    $req.Body = ([System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 6 -Compress)))
    $req.ContentType = 'application/json; charset=utf-8'
  }
  return Invoke-RestMethod @req
}

# --- 1. create repo (ignore if it already exists) -------------------------
Write-Host "`n[1/3] repo $Owner/$RepoName"
try {
  $body = @{ name = $RepoName; description = $Description; private = [bool]$Private; has_issues = $true; has_wiki = $false }
  $repo = Invoke-GH 'POST' "$api/user/repos" $body
  Write-Host ("  created: {0}" -f $repo.html_url)
}
catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 422) { Write-Host '  already exists, continue' }
  else { throw }
}

# --- 2. upload files ------------------------------------------------------
Write-Host "`n[2/3] uploading"
$ok = 0; $fail = 0
foreach ($f in $files) {
  $urlRel = $f.rel -replace '\\', '/'
  $url = "$api/repos/$Owner/$RepoName/contents/$([uri]::EscapeDataString($urlRel).Replace('%2F','/'))"
  $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($f.full))

  # existing SHA is required to update a file that is already there
  $sha = $null
  try { $cur = Invoke-GH 'GET' $url $null; $sha = $cur.sha } catch { }

  $payload = @{ message = "add $urlRel"; content = $b64 }
  if ($sha) { $payload.sha = $sha }
  if ($Private) { $payload.branch = 'main' }

  try {
    $null = Invoke-GH 'PUT' $url $payload
    Write-Host ("  ok   {0}" -f $urlRel); $ok++
  }
  catch {
    Write-Host ("  FAIL {0} -> {1}" -f $urlRel, $_.Exception.Message); $fail++
  }
}

# --- 3. summary -----------------------------------------------------------
Write-Host "`n[3/3] done: $ok ok, $fail failed"
Write-Host "  repo : https://github.com/$Owner/$RepoName"
Write-Host "  next : npm publish --tag experimental  (needs npm login on this machine)"
if ($fail -gt 0) { exit 1 }
