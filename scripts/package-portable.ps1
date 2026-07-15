param(
  [string]$ReleaseDir = "src-tauri/target/release"
)

$ErrorActionPreference = "Stop"

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "Portable source file not found: $Source"
  }
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "Portable source directory not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Copy-Item -Path (Join-Path $Source "*") -Destination $Destination -Recurse -Force
}

$config = Get-Content "src-tauri/tauri.conf.json" -Raw | ConvertFrom-Json
$version = [string]$config.version
$portableRoot = Join-Path $ReleaseDir "portable"
$appDir = Join-Path $portableRoot "Ninety"
$zipPath = Join-Path $portableRoot "Ninety_${version}_windows-x64-portable.zip"

if (Test-Path -LiteralPath $portableRoot) {
  Remove-Item -LiteralPath $portableRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appDir | Out-Null

Copy-RequiredFile (Join-Path $ReleaseDir "ninety.exe") (Join-Path $appDir "Ninety.exe")
Copy-RequiredFile "src-tauri/binaries/sing-box-x86_64-pc-windows-msvc.exe" (Join-Path $appDir "sing-box.exe")
Copy-RequiredFile "src-tauri/binaries/xray-x86_64-pc-windows-msvc.exe" (Join-Path $appDir "xray.exe")
Copy-RequiredFile "src-tauri/binaries/naive-x86_64-pc-windows-msvc.exe" (Join-Path $appDir "naive.exe")
Copy-RequiredFile "src-tauri/binaries/trusttunnel_client-x86_64-pc-windows-msvc.exe" (Join-Path $appDir "trusttunnel_client.exe")
Copy-RequiredFile "src-tauri/binaries/wintun.dll" (Join-Path $appDir "wintun.dll")

Copy-RequiredDirectory "src-tauri/dpi/bin" (Join-Path $appDir "dpi/bin")
Copy-RequiredDirectory "src-tauri/dpi/bin-monkey" (Join-Path $appDir "dpi/bin-monkey")
Copy-RequiredDirectory "src-tauri/dpi/lists" (Join-Path $appDir "dpi/lists")
Copy-RequiredFile "src-tauri/dpi/strategies.json" (Join-Path $appDir "dpi/strategies.json")
Copy-RequiredFile "src-tauri/dpi/version.txt" (Join-Path $appDir "dpi/version.txt")
Copy-RequiredFile "src-tauri/dpi/engine-version.txt" (Join-Path $appDir "dpi/engine-version.txt")
Copy-RequiredDirectory "src-tauri/flags" (Join-Path $appDir "flags")

@"
portable=1
full_portable=1
storage=NinetyData
version=$version
"@ | Set-Content -LiteralPath (Join-Path $appDir "Ninety.portable") -Encoding ascii

@"
Ninety Portable $version

RU: Распакуйте архив целиком в локальную папку с правом записи и запускайте
Ninety.exe. Не переносите только один EXE: рядом необходимы движки и ресурсы.

При первом запуске рядом появится NinetyData. В ней хранятся все профили,
настройки, WebView/localStorage, логи и обновляемые DPI-данные. Чтобы перенести
Ninety на другой ПК, закройте приложение и скопируйте всю папку Ninety целиком.

ВАЖНО: NinetyData содержит URL подписок, пароли нод и ключи WARP в переносимом
виде. Не публикуйте и не передавайте свою рабочую папку Ninety другим людям.

Обновление: закройте Ninety и распакуйте новый Portable ZIP поверх этой папки
с заменой файлов. NinetyData в архив не входит и останется на месте.

EN: Extract the whole archive to a writable local folder and run Ninety.exe.
Do not move the EXE alone: the adjacent engines and resources are required.

NinetyData is created on first launch. It contains all profiles, settings,
WebView/localStorage, logs and updatable DPI data. To move Ninety to another PC,
close the app and copy the entire Ninety folder.

IMPORTANT: NinetyData contains subscription URLs, node passwords and WARP keys
in portable form. Never publish or share your working Ninety folder.

Update: close Ninety and extract the new Portable ZIP over this folder, replacing
program files. NinetyData is not included in the archive and remains untouched.
"@ | Set-Content -LiteralPath (Join-Path $appDir "README.txt") -Encoding utf8

Compress-Archive -LiteralPath $appDir -DestinationPath $zipPath -CompressionLevel Optimal

$zip = Get-Item -LiteralPath $zipPath
if ($zip.Length -lt 5MB) {
  throw "Portable ZIP is suspiciously small: $($zip.Length) bytes"
}

Write-Host "Portable package: $($zip.FullName) ($([math]::Round($zip.Length / 1MB, 1)) MB)"
