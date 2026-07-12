param(
  [string]$LatestJson = "latest.json"
)

$ErrorActionPreference = "Stop"

function Assert-Release([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$config = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$version = [string]$config.version
$releaseDir = "src-tauri/target/release"
$app = Get-Item "$releaseDir/ninety.exe"
$nsis = @(Get-ChildItem "$releaseDir/bundle/nsis/*-setup.exe")
$msi = @(Get-ChildItem "$releaseDir/bundle/msi/*.msi")
$sigs = @(Get-ChildItem "$releaseDir/bundle/nsis/*-setup.exe.sig")

Assert-Release ($app.Length -gt 2MB) "Ninety.exe отсутствует либо подозрительно мал"
Assert-Release ($nsis.Count -eq 1) "ожидался ровно один NSIS installer"
Assert-Release ($msi.Count -eq 1) "ожидался ровно один MSI installer"
Assert-Release ($sigs.Count -eq 1) "ожидалась ровно одна Tauri updater signature"
Assert-Release ($nsis[0].Length -gt 5MB) "NSIS installer подозрительно мал"
Assert-Release ($msi[0].Length -gt 5MB) "MSI installer подозрительно мал"
Assert-Release ($sigs[0].Length -gt 32) "Tauri updater signature пуста"
Assert-Release ($nsis[0].Name -match [regex]::Escape($version)) "версия отсутствует в имени NSIS"
Assert-Release ($msi[0].Name -match [regex]::Escape($version)) "версия отсутствует в имени MSI"

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
$process = Start-Process -FilePath $app.FullName -ArgumentList "--ci-smoke" -PassThru
if (-not $process.WaitForExit(15000)) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw "Ninety.exe не завершил CI smoke за 15 секунд"
}
Assert-Release ($process.ExitCode -eq 0) "Ninety.exe CI smoke завершился с кодом $($process.ExitCode)"

$authenticodeFiles = @($app, $nsis[0], $msi[0])
$authenticodeEnabled = $env:AUTHENTICODE_ENABLED -eq "true"
foreach ($file in $authenticodeFiles) {
  $status = Get-AuthenticodeSignature $file.FullName
  if ($authenticodeEnabled) {
    Assert-Release ($status.Status -eq "Valid") "Authenticode $($file.Name): $($status.Status)"
  } else {
    Write-Host "Authenticode $($file.Name): $($status.Status) (production certificate не настроен)"
  }
}

Write-Host "Release smoke OK: version=$version, NSIS=$($nsis[0].Name), MSI=$($msi[0].Name)"
