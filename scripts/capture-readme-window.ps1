param(
  [Parameter(Mandatory = $true)]
  [string]$App,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$App = (Resolve-Path $App).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NinetyReadmeWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  public static string ReadTitle(IntPtr hWnd) {
    var value = new StringBuilder(256);
    GetWindowText(hWnd, value, value.Capacity);
    return value.ToString();
  }
}
"@

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$targetWidth = [Math]::Min(1100, $workingArea.Width)
$targetHeight = [Math]::Min(720, $workingArea.Height)
if ($targetWidth -lt 1000 -or $targetHeight -lt 650) {
  throw "Windows work area is too small for README capture: $($workingArea.Width)x$($workingArea.Height)"
}
Write-Host "README capture work area: $($workingArea.Width)x$($workingArea.Height); window: ${targetWidth}x${targetHeight}"

$views = @("home", "nodes", "profiles", "dpi", "settings", "logs", "quality")
$hashes = @{}
$expectedWidth = 0
$expectedHeight = 0

function Wait-NinetyWindow([System.Diagnostics.Process]$Process, [string]$View) {
  $deadline = (Get-Date).AddSeconds(35)
  $lastTitle = ""
  do {
    Start-Sleep -Milliseconds 120
    $Process.Refresh()
    if ($Process.HasExited) {
      throw "Ninety exited before ${View} became ready (code $($Process.ExitCode))"
    }
    $handle = $Process.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) {
      $lastTitle = [NinetyReadmeWin32]::ReadTitle($handle)
      if ($lastTitle -like "*Ninety README ${View} READY*") { return $handle }
      if ($lastTitle -like "*Ninety README sequence ERROR*") {
        throw "Ninety reported capture sequence error while waiting for ${View}: $lastTitle"
      }
    }
  } until ((Get-Date) -gt $deadline)
  throw "Ninety window was not ready for ${View}; last title='$lastTitle'"
}

function Save-NinetyWindow([IntPtr]$Window, [string]$Name) {
  [NinetyReadmeWin32]::ShowWindow($Window, 9) | Out-Null
  [NinetyReadmeWin32]::MoveWindow(
    $Window,
    $workingArea.Left,
    $workingArea.Top,
    $targetWidth,
    $targetHeight,
    $true
  ) | Out-Null
  [NinetyReadmeWin32]::SetForegroundWindow($Window) | Out-Null
  Start-Sleep -Milliseconds 650

  $rect = New-Object NinetyReadmeWin32+RECT
  if (-not [NinetyReadmeWin32]::GetWindowRect($Window, [ref]$rect)) {
    throw "GetWindowRect failed for ${Name}"
  }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 1000 -or $height -lt 650) {
    throw "Unexpected Ninety window size for ${Name}: ${width}x${height}"
  }
  if ($rect.Left -lt $workingArea.Left -or $rect.Top -lt $workingArea.Top -or
      $rect.Right -gt $workingArea.Right -or $rect.Bottom -gt $workingArea.Bottom) {
    throw "Ninety window exceeds the work area for ${Name}: [$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)]"
  }

  if ($script:expectedWidth -eq 0) {
    $script:expectedWidth = $width
    $script:expectedHeight = $height
  } elseif ($width -ne $script:expectedWidth -or $height -ne $script:expectedHeight) {
    throw "Inconsistent Ninety window size for ${Name}: ${width}x${height}, expected $($script:expectedWidth)x$($script:expectedHeight)"
  }

  $path = Join-Path $OutputDirectory $Name
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

    $sum = 0.0
    $sumSq = 0.0
    $count = 0
    $nearBlack = 0
    $nearWhite = 0
    for ($y = 0; $y -lt $height; $y += 8) {
      for ($x = 0; $x -lt $width; $x += 8) {
        $pixel = $bitmap.GetPixel($x, $y)
        $value = ($pixel.R + $pixel.G + $pixel.B) / 3.0
        $sum += $value
        $sumSq += $value * $value
        $count++
        if ($pixel.R -lt 8 -and $pixel.G -lt 8 -and $pixel.B -lt 8) { $nearBlack++ }
        if ($pixel.R -gt 247 -and $pixel.G -gt 247 -and $pixel.B -gt 247) { $nearWhite++ }
      }
    }
    $mean = $sum / [Math]::Max(1, $count)
    $variance = ($sumSq / [Math]::Max(1, $count)) - ($mean * $mean)
    $stdDev = [Math]::Sqrt([Math]::Max(0, $variance))
    $blackRatio = $nearBlack / [double][Math]::Max(1, $count)
    $whiteRatio = $nearWhite / [double][Math]::Max(1, $count)
    if ($stdDev -lt 12) { throw "Screenshot ${Name} lacks visual variance (stddev=$([Math]::Round($stdDev, 2)))" }
    if ($blackRatio -gt 0.94 -or $whiteRatio -gt 0.94) {
      throw "Screenshot ${Name} appears blank (black=$([Math]::Round($blackRatio * 100, 1))%, white=$([Math]::Round($whiteRatio * 100, 1))%)"
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }

  $file = Get-Item $path
  if ($file.Length -lt 45000) {
    throw "Screenshot ${Name} is suspiciously small: $($file.Length) bytes"
  }
  $sha = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
  if ($hashes.ContainsKey($sha)) { throw "Duplicate screenshot detected: ${Name}" }
  $hashes[$sha] = $Name
  Write-Host "Captured ${Name}: ${width}x${height}, $($file.Length) bytes"
}

$process = Start-Process -FilePath $App -PassThru
try {
  foreach ($view in $views) {
    $window = Wait-NinetyWindow -Process $process -View $view
    Save-NinetyWindow -Window $window -Name "$view.png"
  }

  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 150
    $process.Refresh()
    if ($process.HasExited) { break }
    $title = if ($process.MainWindowHandle -ne [IntPtr]::Zero) { [NinetyReadmeWin32]::ReadTitle($process.MainWindowHandle) } else { "" }
    if ($title -like "*Ninety README sequence DONE*") { break }
    if ($title -like "*Ninety README sequence ERROR*") { throw "Ninety reported capture sequence error: $title" }
  } until ((Get-Date) -gt $deadline)
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    try { $process.WaitForExit(5000) | Out-Null } catch {}
  }
}

$missing = $views | Where-Object { -not (Test-Path (Join-Path $OutputDirectory "$_.png")) }
if ($missing) { throw "Missing README screenshots: $($missing -join ', ')" }
Write-Host "Captured and validated $($views.Count) real Ninety window screenshots."
