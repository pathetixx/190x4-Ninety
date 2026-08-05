param(
  [string]$LatestJson = "latest.json"
)

$ErrorActionPreference = "Stop"

# --ci-smoke пишет и стирает боевой profile store, поэтому в самом приложении
# он включается только этим opt-in'ом (см. ci_smoke_requested в lib.rs). Без
# переменной релизный бинарь игнорирует флаг и стартует как обычно.
$env:NINETY_CI_SMOKE = "1"

function Assert-Release([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$config = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$version = [string]$config.version
$releaseDir = "src-tauri/target/release"
$app = Get-Item "$releaseDir/ninety.exe"
$nsis = @(Get-ChildItem "$releaseDir/bundle/nsis/*$version*-setup.exe")
$msi = @(Get-ChildItem "$releaseDir/bundle/msi/*$version*.msi")
$sigs = @(Get-ChildItem "$releaseDir/bundle/nsis/*$version*-setup.exe.sig")
$portableZips = @(Get-ChildItem "$releaseDir/portable/*$version*_windows-x64-portable.zip")
$portableDir = Join-Path $releaseDir "portable/Ninety"
$portableApp = Get-Item (Join-Path $portableDir "Ninety.exe")

Assert-Release ($app.Length -gt 2MB) "Ninety.exe отсутствует либо подозрительно мал"
Assert-Release ($nsis.Count -eq 1) "ожидался ровно один NSIS installer"
Assert-Release ($msi.Count -eq 1) "ожидался ровно один MSI installer"
Assert-Release ($sigs.Count -eq 1) "ожидалась ровно одна Tauri updater signature"
Assert-Release ($portableZips.Count -eq 1) "ожидался ровно один Portable ZIP"
Assert-Release ($nsis[0].Length -gt 5MB) "NSIS installer подозрительно мал"
Assert-Release ($msi[0].Length -gt 5MB) "MSI installer подозрительно мал"
Assert-Release ($sigs[0].Length -gt 32) "Tauri updater signature пуста"
Assert-Release ($portableZips[0].Length -gt 5MB) "Portable ZIP подозрительно мал"
Assert-Release ($nsis[0].Name -match [regex]::Escape($version)) "версия отсутствует в имени NSIS"
Assert-Release ($msi[0].Name -match [regex]::Escape($version)) "версия отсутствует в имени MSI"
Assert-Release ($portableZips[0].Name -match [regex]::Escape($version)) "версия отсутствует в имени Portable ZIP"

$portableFiles = @(
  "Ninety.exe",
  "Ninety.portable",
  "README.txt",
  "sing-box.exe",
  "xray.exe",
  "naive.exe",
  "trusttunnel_client.exe",
  "wintun.dll",
  "dpi/strategies.json",
  "dpi/bin/winws.exe",
  "dpi/bin-monkey/winws.exe",
  "flags/ru.png"
)
foreach ($name in $portableFiles) {
  Assert-Release (Test-Path -LiteralPath (Join-Path $portableDir $name) -PathType Leaf) `
    "в Portable staging отсутствует $name"
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($portableZips[0].FullName)
try {
  $entries = @($archive.Entries | ForEach-Object {
    $_.FullName.Replace([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  })
  foreach ($name in $portableFiles) {
    $entry = "Ninety/$name"
    Assert-Release ($entries -contains $entry) "в Portable ZIP отсутствует $entry"
  }
} finally {
  $archive.Dispose()
}

$productVersion = [string]$app.VersionInfo.ProductVersion
Assert-Release ($productVersion -match "^$([regex]::Escape($version))(?:\D|$)") `
  "ProductVersion Ninety.exe '$productVersion' не совпадает с '$version'"

$sidecars = @(
  @{ Path = "src-tauri/binaries/sing-box-x86_64-pc-windows-msvc.exe"; Min = 1MB },
  @{ Path = "src-tauri/binaries/xray-x86_64-pc-windows-msvc.exe"; Min = 1MB },
  @{ Path = "src-tauri/binaries/naive-x86_64-pc-windows-msvc.exe"; Min = 1MB },
  @{ Path = "src-tauri/binaries/trusttunnel_client-x86_64-pc-windows-msvc.exe"; Min = 512KB },
  @{ Path = "src-tauri/binaries/wintun.dll"; Min = 32KB }
)
foreach ($sidecar in $sidecars) {
  $file = Get-Item $sidecar.Path
  Assert-Release ($file.Length -gt $sidecar.Min) "$($sidecar.Path) отсутствует либо подозрительно мал"
}

if (Test-Path $LatestJson) {
  $latest = Get-Content $LatestJson -Raw | ConvertFrom-Json
  $platform = $latest.platforms.'windows-x86_64'
  $expectedUrl = "https://github.com/pathetixx/190x4-Ninety/releases/download/$($env:GITHUB_REF_NAME)/$($nsis[0].Name)"
  Assert-Release ([string]$latest.version -eq $version) "версия latest.json не совпадает"
  Assert-Release ($null -ne $platform) "в latest.json нет windows-x86_64"
  Assert-Release (-not [string]::IsNullOrWhiteSpace([string]$platform.signature)) "в latest.json нет signature"
  Assert-Release ([string]$platform.signature -eq (Get-Content $sigs[0].FullName -Raw).Trim()) `
    "signature latest.json не совпадает с .sig"
  Assert-Release ([string]$platform.url -eq $expectedUrl) "URL latest.json не совпадает с installer"
}

# Полный boot Tauri без сети/VPN. --ci-smoke проверяет backend ping и сам
# вызывает app.exit(0) через три секунды; зависание или мгновенный crash валят CI.
# Лимит ожидания измеряет холодный старт, а не выход: на свежем раннере первый
# запуск WebView2 и сканирование неподписанного exe Defender'ом съедали почти
# все 30 секунд и валили сборку на здоровом бинаре. 90 секунд по-прежнему ловят
# реальное зависание, но не гонку с первым запуском.
$process = Start-Process -FilePath $app.FullName -ArgumentList "--ci-smoke" -PassThru
if (-not $process.WaitForExit(90000)) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "Ninety.exe не завершил CI smoke за 90 секунд"
}
Assert-Release ($process.ExitCode -eq 0) "Ninety.exe CI smoke завершился с кодом $($process.ExitCode)"

# Тот же boot из реально подготовленного Portable layout. Маркер рядом с EXE
# включает безопасное portable-поведение updater'а.
$portableProcess = Start-Process -FilePath $portableApp.FullName -ArgumentList "--ci-smoke" -PassThru
if (-not $portableProcess.WaitForExit(90000)) {
  Stop-Process -Id $portableProcess.Id -Force -ErrorAction SilentlyContinue
  throw "Portable Ninety.exe не завершил CI smoke за 90 секунд"
}
Assert-Release ($portableProcess.ExitCode -eq 0) `
  "Portable Ninety.exe CI smoke завершился с кодом $($portableProcess.ExitCode)"
foreach ($name in @("config", "data", "logs", "webview")) {
  Assert-Release (Test-Path -LiteralPath (Join-Path $portableDir "NinetyData/$name") -PathType Container) `
    "Full Portable не создал NinetyData/$name"
}
Assert-Release (Test-Path -LiteralPath (Join-Path $portableDir "NinetyData/config/state-backup.json") -PathType Leaf) `
  "Full Portable не записал state backup в NinetyData/config"

function Invoke-Setup([string[]]$InstallerArgs, [int]$TimeoutMs = 120000) {
  $setup = Start-Process -FilePath $nsis[0].FullName -ArgumentList $InstallerArgs -PassThru
  if (-not $setup.WaitForExit($TimeoutMs)) {
    Stop-Process -Id $setup.Id -Force -ErrorAction SilentlyContinue
    throw "NSIS setup завис: $($InstallerArgs -join ' ')"
  }
  return $setup.ExitCode
}

function Invoke-SetupAfterSequentialCleanup([string[]]$InstallerArgs, [int]$TimeoutMs = 12000) {
  $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
  do {
    $exit = Invoke-Setup $InstallerArgs
    if ($exit -ne 4) {
      return $exit
    }
    # NSIS removal may finish from a short-lived temporary child after the
    # install directory is already gone. Retry only the sequential handoff;
    # the dedicated overlap check above still expects code 4 immediately.
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)
  return $exit
}

function Get-InstallManifest([string]$Root) {
  return @(
    Get-ChildItem -LiteralPath $Root -File -Recurse |
      Sort-Object FullName |
      ForEach-Object {
        $relative = [IO.Path]::GetRelativePath($Root, $_.FullName).Replace(
          [IO.Path]::DirectorySeparatorChar,
          [IO.Path]::AltDirectorySeparatorChar
        )
        "$relative|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
      }
  )
}

function Wait-Removed([string]$Path, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Test-Path -LiteralPath $Path) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
  }
  Assert-Release (-not (Test-Path -LiteralPath $Path)) "uninstaller не удалил $Path"
}

# Exercise the real production NSIS, not only the app executable. The legacy
# path models users installed in AppData before Program Files became the fresh
# default. Reinstall/OTA must update that exact path and never create a duplicate.
$legacyInstall = Join-Path $env:LOCALAPPDATA "NinetyLegacySmoke-$PID"
$programFilesInstall = Join-Path $env:ProgramFiles "Ninety"
$bundleIdentifier = [string]$config.identifier
$identifierParts = @($bundleIdentifier.Split('.'))
$manufacturer = if ($identifierParts.Count -gt 1) { $identifierParts[1] } else { $bundleIdentifier }
Assert-Release (-not [string]::IsNullOrWhiteSpace($manufacturer)) `
  "невозможно определить manufacturer из bundle identifier '$bundleIdentifier'"
$ninetyUserRegistry = "HKCU:\Software\$manufacturer\Ninety"
Remove-Item -LiteralPath $legacyInstall -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ninetyUserRegistry -Recurse -Force -ErrorAction SilentlyContinue
Assert-Release (-not (Test-Path -LiteralPath $programFilesInstall)) `
  "legacy-path smoke requires an empty Program Files target"

try {
  # Model a user installed before Program Files became the fresh default. The
  # product registry value, not /D, is the source of truth for a real OTA.
  New-Item -Path $ninetyUserRegistry -Force | Out-Null
  Set-Item -Path $ninetyUserRegistry -Value $legacyInstall
  $exit = Invoke-Setup @("/S", "/CurrentUser")
  Assert-Release ($exit -eq 0) "clean NSIS install завершился с кодом $exit"
  foreach ($name in @(
    "Ninety.exe", "uninstall.exe", "sing-box.exe", "xray.exe", "naive.exe",
    "trusttunnel_client.exe", "wintun.dll", "dpi/strategies.json", "dpi/bin/winws.exe",
    "dpi/bin-monkey/winws.exe", "flags/ma.png", "flags/ru.png"
  )) {
    Assert-Release (Test-Path -LiteralPath (Join-Path $legacyInstall $name) -PathType Leaf) `
      "production NSIS не установил $name"
  }

  $sourceFlags = @(Get-ChildItem -LiteralPath "src-tauri/flags" -File -Filter "*.png")
  $installedFlags = @(Get-ChildItem -LiteralPath (Join-Path $legacyInstall "flags") -File -Filter "*.png")
  Assert-Release ($installedFlags.Count -eq $sourceFlags.Count) `
    "production NSIS установил $($installedFlags.Count) флагов вместо $($sourceFlags.Count)"
  foreach ($sourceFlag in $sourceFlags) {
    $installedFlag = Join-Path $legacyInstall "flags/$($sourceFlag.Name)"
    Assert-Release (Test-Path -LiteralPath $installedFlag -PathType Leaf) `
      "production NSIS потерял flags/$($sourceFlag.Name)"
    Assert-Release ((Get-FileHash -LiteralPath $installedFlag -Algorithm SHA256).Hash -eq `
      (Get-FileHash -LiteralPath $sourceFlag.FullName -Algorithm SHA256).Hash) `
      "production NSIS повредил flags/$($sourceFlag.Name)"
  }

  # Exact regression from v0.2.28: a locked flags/ma.png must fail once before
  # extraction, without partial replacement or a cascade of per-file dialogs.
  $beforeLockedUpdate = Get-InstallManifest $legacyInstall
  $maPath = Join-Path $legacyInstall "flags/ma.png"
  $maLock = [IO.File]::Open($maPath, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $lockedSetup = Start-Process -FilePath $nsis[0].FullName `
      -ArgumentList @("/S", "/P", "/UPDATE") -PassThru
    Start-Sleep -Milliseconds 1500
    Assert-Release (-not $lockedSetup.HasExited) `
      "locked-resource update did not enter its bounded handle wait"
    $duplicateExit = Invoke-Setup @("/S", "/P", "/UPDATE") 15000
    Assert-Release ($duplicateExit -eq 4) `
      "parallel setup должен завершаться кодом 4, получен $duplicateExit"
    if (-not $lockedSetup.WaitForExit(15000)) {
      Stop-Process -Id $lockedSetup.Id -Force -ErrorAction SilentlyContinue
      throw "locked-resource update не завершил ограниченное ожидание"
    }
    $lockedExit = $lockedSetup.ExitCode
  } finally {
    $maLock.Dispose()
    if ($null -ne $lockedSetup -and -not $lockedSetup.HasExited) {
      Stop-Process -Id $lockedSetup.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Assert-Release ($lockedExit -eq 5) `
    "locked-resource update должен завершаться кодом 5 до распаковки, получен $lockedExit"
  $afterLockedUpdate = Get-InstallManifest $legacyInstall
  Assert-Release (-not (Compare-Object $beforeLockedUpdate $afterLockedUpdate)) `
    "locked-resource update частично изменил существующую установку"

  # With the lock gone the same OTA-style invocation must reuse the registered
  # AppData path. Program Files must stay untouched: no duplicate installation.
  $exit = Invoke-Setup @("/S", "/P", "/UPDATE")
  Assert-Release ($exit -eq 0) "OTA-style reinstall завершился с кодом $exit"
  Assert-Release (Test-Path -LiteralPath (Join-Path $legacyInstall "flags/ma.png") -PathType Leaf) `
    "OTA-style reinstall потерял flags/ma.png"
  Assert-Release (-not (Test-Path -LiteralPath $programFilesInstall)) `
    "OTA existing AppData install создал дубликат в Program Files"

  $installedProcess = Start-Process -FilePath (Join-Path $legacyInstall "Ninety.exe") `
    -ArgumentList "--ci-smoke" -PassThru
  if (-not $installedProcess.WaitForExit(30000)) {
    Stop-Process -Id $installedProcess.Id -Force -ErrorAction SilentlyContinue
    throw "установленный через production NSIS Ninety.exe завис в CI smoke"
  }
  Assert-Release ($installedProcess.ExitCode -eq 0) `
    "установленный через production NSIS Ninety.exe завершился с кодом $($installedProcess.ExitCode)"

  $uninstall = Start-Process -FilePath (Join-Path $legacyInstall "uninstall.exe") `
    -ArgumentList "/S" -PassThru
  $uninstall.WaitForExit(30000) | Out-Null
  Wait-Removed $legacyInstall
} finally {
  if (Test-Path -LiteralPath $legacyInstall) {
    Remove-Item -LiteralPath $legacyInstall -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $ninetyUserRegistry -Recurse -Force -ErrorAction SilentlyContinue
}

# Retaining app data after uninstall intentionally preserves the remembered
# destination for real users. Remove only the ephemeral CI registration before
# testing a truly fresh machine-wide install.
Remove-Item -LiteralPath $ninetyUserRegistry -Recurse -Force -ErrorAction SilentlyContinue

# A genuinely fresh install has no registered destination and must choose
# Program Files even when the user chooses the current-account scope. This runs
# only after the legacy-path scenario has removed its CI registry registration.
Assert-Release (-not (Test-Path -LiteralPath $programFilesInstall)) `
  "fresh-install smoke requires an empty Program Files target"
try {
  $exit = Invoke-SetupAfterSequentialCleanup @("/S", "/CurrentUser")
  Assert-Release ($exit -eq 0) "fresh Program Files install завершился с кодом $exit"
  Assert-Release (Test-Path -LiteralPath (Join-Path $programFilesInstall "Ninety.exe") -PathType Leaf) `
    "fresh install не выбрал Program Files"
  Assert-Release (Test-Path -LiteralPath (Join-Path $programFilesInstall "flags/ma.png") -PathType Leaf) `
    "fresh Program Files install потерял flags/ma.png"

  $uninstall = Start-Process -FilePath (Join-Path $programFilesInstall "uninstall.exe") `
    -ArgumentList "/S" -PassThru
  $uninstall.WaitForExit(30000) | Out-Null
  Wait-Removed $programFilesInstall
} finally {
  if (Test-Path -LiteralPath $programFilesInstall) {
    Remove-Item -LiteralPath $programFilesInstall -Recurse -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $ninetyUserRegistry -Recurse -Force -ErrorAction SilentlyContinue
}

$authenticodeFiles = @($app, $portableApp, $nsis[0], $msi[0])
$authenticodeEnabled = $env:AUTHENTICODE_ENABLED -eq "true"
foreach ($file in $authenticodeFiles) {
  $status = Get-AuthenticodeSignature $file.FullName
  if ($authenticodeEnabled) {
    Assert-Release ($status.Status -eq "Valid") "Authenticode $($file.Name): $($status.Status)"
  } else {
    Write-Host "Authenticode $($file.Name): $($status.Status) (production certificate не настроен)"
  }
}

Write-Host "Release smoke OK: version=$version, NSIS=$($nsis[0].Name), MSI=$($msi[0].Name), Portable=$($portableZips[0].Name)"
