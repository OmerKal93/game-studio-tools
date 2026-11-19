# Saves a secret (API key) for the current Windows user, encrypted with DPAPI.
# Run it yourself in a PowerShell window:  powershell -ExecutionPolicy Bypass -File set-secret.ps1 -Name GOOGLE_AI_API_KEY
# The value is typed into a hidden prompt, never echoed, and stored outside every repo and backup:
#   %LOCALAPPDATA%\GameStudioSecrets\<Name>.dpapi  (readable only by this user on this PC; set GAME_STUDIO_SECRETS_DIR to use another folder)
param([Parameter(Mandatory)][ValidatePattern('^[A-Z0-9_]+$')][string]$Name)
$ErrorActionPreference = 'Stop'
$dir = if ($env:GAME_STUDIO_SECRETS_DIR) { $env:GAME_STUDIO_SECRETS_DIR } else { Join-Path $env:LOCALAPPDATA 'GameStudioSecrets' }
New-Item -ItemType Directory -Force $dir | Out-Null
$s = Read-Host "Paste $Name, then press Enter (input is hidden)" -AsSecureString
if ($s.Length -lt 8) { throw "Nothing usable was pasted ($($s.Length) characters). Nothing saved." }
$s | ConvertFrom-SecureString | Set-Content -Encoding ascii (Join-Path $dir "$Name.dpapi")
Write-Host "Saved $Name ($($s.Length) characters), encrypted for $env:USERNAME on this PC."
