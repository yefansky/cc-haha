[CmdletBinding()]
param(
  [string]$DataDir = (Join-Path (Split-Path -Parent $PSScriptRoot) '.cc-haha-audit'),
  [switch]$ConfigureDeepSeekKey,
  [switch]$ForgetDeepSeekKey
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$keyFile = Join-Path $DataDir 'deepseek-api-key.dpapi'

function Save-DeepSeekApiKey {
  $secureKey = Read-Host 'Paste DeepSeek API Key (input is hidden)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrWhiteSpace($plainKey)) {
      throw 'DeepSeek API Key cannot be empty.'
    }
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }

  # Without an explicit encryption key, DPAPI binds this value to the current
  # Windows user and machine. The encrypted file is not portable or shareable.
  $secureKey | ConvertFrom-SecureString | Set-Content -LiteralPath $keyFile -Encoding ascii -NoNewline
  Write-Host "DeepSeek API Key saved with Windows user encryption: $keyFile" -ForegroundColor Green
}

function Get-DeepSeekApiKey {
  $encryptedKey = Get-Content -LiteralPath $keyFile -Raw -Encoding ascii
  $secureKey = ConvertTo-SecureString -String $encryptedKey
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'desktop\package.json'))) {
  throw "Claude Code Haha repository was not found at: $repoRoot"
}
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  throw 'Bun was not found. Install Bun before launching the source desktop app.'
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

if ($ForgetDeepSeekKey -and (Test-Path -LiteralPath $keyFile)) {
  Remove-Item -LiteralPath $keyFile -Force
  Write-Host 'Deleted the locally encrypted DeepSeek API Key.' -ForegroundColor Yellow
  if (-not $ConfigureDeepSeekKey) {
    return
  }
}
if ($ConfigureDeepSeekKey -or -not (Test-Path -LiteralPath $keyFile)) {
  Save-DeepSeekApiKey
}

$apiKey = Get-DeepSeekApiKey
if ([string]::IsNullOrWhiteSpace($apiKey)) {
  throw 'Could not read the DeepSeek API Key. Run with -ConfigureDeepSeekKey to save it again.'
}

$env:CLAUDE_CONFIG_DIR = $DataDir
$env:ANTHROPIC_AUTH_TOKEN = $apiKey
$env:ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'
$env:ANTHROPIC_MODEL = 'deepseek-v4-pro'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek-v4-flash'
$env:CC_HAHA_TRACE_API_CALLS = '1'
$env:CC_HAHA_TRACE_PROVIDER_ID = 'deepseek-direct'
$env:CC_HAHA_TRACE_PROVIDER_NAME = 'DeepSeek Direct Anthropic'
$env:CC_HAHA_TRACE_PROVIDER_FORMAT = 'anthropic'
$env:DISABLE_TELEMETRY = '1'
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'
$env:NO_PROXY = 'localhost,127.0.0.1,::1'
$env:no_proxy = $env:NO_PROXY

Write-Host 'Starting Claude Code Haha with DeepSeek and API Trace enabled.' -ForegroundColor Cyan
Write-Host "Isolated data directory: $DataDir" -ForegroundColor DarkCyan

Push-Location (Join-Path $repoRoot 'desktop')
try {
  bun run electron:dev
} finally {
  Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
  $apiKey = $null
  Pop-Location
}
