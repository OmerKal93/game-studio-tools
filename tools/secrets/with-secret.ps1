# Runs one command with a DPAPI-saved secret in its environment, then clears it. Never prints the value.
#   powershell -ExecutionPolicy Bypass -File with-secret.ps1 -Name GOOGLE_AI_API_KEY -Run "python tool.py args"
#   ... -Name X -Check   -> prints only whether the secret exists and its length
# (-Run is one string: PowerShell 5.1 -File binds a bare "--" or "-x" args as parameters.)
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Z0-9_]+$')][string]$Name,
  [switch]$Check,
  [string]$Run
)
$ErrorActionPreference = 'Stop'
$dir = if ($env:GAME_STUDIO_SECRETS_DIR) { $env:GAME_STUDIO_SECRETS_DIR } else { Join-Path $env:LOCALAPPDATA 'GameStudioSecrets' }
$f = Join-Path $dir "$Name.dpapi"
if (-not (Test-Path $f)) { Write-Host "MISSING $Name (run set-secret.ps1 -Name $Name)"; exit 3 }
$sec = Get-Content $f | ConvertTo-SecureString
if ($Check) { Write-Host "OK $Name length=$($sec.Length)"; exit 0 }
if (-not $Run) { throw 'Give the command with -Run "..."' }
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  [Environment]::SetEnvironmentVariable($Name, [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b), 'Process')
} finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
try {
  & cmd /c $Run
  $code = $LASTEXITCODE
} finally { [Environment]::SetEnvironmentVariable($Name, $null, 'Process') }
exit $code
