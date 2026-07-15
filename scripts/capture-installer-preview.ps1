param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$Installer = (Resolve-Path $Installer).Path

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NinetyPreviewWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
}
"@

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$process = Start-Process -FilePath $Installer -PassThru

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $window = $process.MainWindowHandle
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Installer window did not appear" }

  function Get-InstallerRect {
    $rect = New-Object NinetyPreviewWin32+RECT
    if (-not [NinetyPreviewWin32]::GetWindowRect($window, [ref]$rect)) {
      throw "GetWindowRect failed"
    }
    return $rect
  }

  function Save-InstallerWindow([string]$Name) {
    $rect = Get-InstallerRect
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 700 -or $height -lt 500) {
      throw "Unexpected installer size: ${width}x${height}"
    }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      $bitmap.Save((Join-Path $OutputDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Seconds 2
  Save-InstallerWindow "00-before-drag.png"

  # Exercise real frameless-window dragging before taking the first capture.
  $before = Get-InstallerRect
  $startX = $before.Left + 470
  $startY = $before.Top + 36
  [NinetyPreviewWin32]::SetCursorPos($startX, $startY) | Out-Null
  [NinetyPreviewWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 160
  [NinetyPreviewWin32]::SetCursorPos($startX + 70, $startY + 35) | Out-Null
  Start-Sleep -Milliseconds 160
  [NinetyPreviewWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 500
  $after = Get-InstallerRect
  if ($after.Left -eq $before.Left -and $after.Top -eq $before.Top) {
    throw "Frameless installer window did not move during drag test"
  }

  Save-InstallerWindow "01-welcome.png"
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Seconds 3
  Save-InstallerWindow "02-progress.png"
  Start-Sleep -Seconds 5
  [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
  Start-Sleep -Seconds 1
  Save-InstallerWindow "03-finish.png"
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
