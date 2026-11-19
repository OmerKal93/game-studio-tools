# Build a debug APK with the local Android toolchain, then verify and archive it.
# usage: powershell -File apk-build.ps1 -Project <android project dir> -OutDir <archive dir> -Name <base name>
# Prints one JSON line: apk path, sha256, bytes, package, versionCode, versionName, signature result.
param(
  [Parameter(Mandatory)][string]$Project,
  [Parameter(Mandatory)][string]$OutDir,
  [Parameter(Mandatory)][string]$Name,
  [string]$Task = 'assembleDebug',
  [string]$Toolchain = $env:ANDROID_TOOLCHAIN  # folder holding env.ps1, gradle-dist and gradle-home
)
$ErrorActionPreference = 'Stop'
if (-not $Toolchain) { throw 'Set ANDROID_TOOLCHAIN or pass -Toolchain <folder with env.ps1, gradle-dist, gradle-home>' }
. "$Toolchain\env.ps1"
$env:GRADLE_USER_HOME = "$Toolchain\gradle-home"
$gradle = Get-ChildItem "$Toolchain\gradle-dist" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$started = Get-Date
Push-Location $Project
try { & "$($gradle.FullName)\bin\gradle.bat" --no-daemon $Task; if ($LASTEXITCODE) { throw "gradle $Task failed ($LASTEXITCODE)" } }
finally { Pop-Location }

$apk = Get-ChildItem $Project -Recurse -Filter *.apk | Where-Object { $_.FullName -match '\\build\\outputs\\apk\\' -and $_.LastWriteTime -ge $started } |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $apk) { throw 'no APK written by this build' }

$bt = Get-ChildItem "$env:ANDROID_HOME\build-tools" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$badging = & "$($bt.FullName)\aapt.exe" dump badging $apk.FullName
$pkg = [regex]::Match(($badging -join "`n"), "package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'")
if (-not $pkg.Success) { throw 'aapt could not read the package line' }
$sig = & "$($bt.FullName)\apksigner.bat" verify --verbose $apk.FullName 2>&1
if (-not ($sig -match '^Verifies')) { throw "apksigner did not verify: $($sig -join ' ')" }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$dest = Join-Path $OutDir "$Name-$($pkg.Groups[3].Value).apk"
Copy-Item $apk.FullName $dest -Force
$base = [IO.Path]::ChangeExtension($dest, $null).TrimEnd('.')
$badging | Out-File "$base.badging.txt" -Encoding utf8
$sig | Out-File "$base.apksigner.txt" -Encoding utf8
$sha = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
"$sha  $(Split-Path $dest -Leaf)" | Out-File "$base.sha256" -Encoding ascii
$perms = @($badging | Where-Object { $_ -like 'uses-permission:*' }).Count
[ordered]@{ apk = $dest; sha256 = $sha; bytes = (Get-Item $dest).Length; package = $pkg.Groups[1].Value
  versionCode = $pkg.Groups[2].Value; versionName = $pkg.Groups[3].Value; signature = 'Verifies'
  schemes = @($sig | Where-Object { $_ -match 'scheme \(.*\): true' }); usesPermission = $perms } | ConvertTo-Json -Compress
