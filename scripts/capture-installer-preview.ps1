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
  public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int x, int y, int width, int height, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern IntPtr GetSystemMenu(IntPtr hWnd, bool revert);
  [DllImport("user32.dll")] public static extern uint GetMenuState(IntPtr menu, uint id, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  public static IntPtr FindDescendantById(IntPtr parent, int id) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (GetDlgCtrlID(child) == id) { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindKuroganeWindow() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr param) {
      if (IsWindowVisible(window) &&
          GetDlgItem(window, 1205) != IntPtr.Zero &&
          GetDlgItem(window, 1207) != IntPtr.Zero) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string ReadText(IntPtr hWnd) {
    var value = new System.Text.StringBuilder(128);
    GetWindowText(hWnd, value, value.Capacity);
    return value.ToString();
  }
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
      # System-white chrome is a release blocker. Small white glyphs are fine;
      # the old regression produced thousands of near-white pixels in solid
      # top/footer rectangles.
      $bitmap.Save((Join-Path $OutputDirectory $Name), [System.Drawing.Imaging.ImageFormat]::Png)
      $nearWhite = 0
      $contentNearWhite = 0
      for ($y = 0; $y -lt $height; $y += 2) {
        $inTopChrome = $y -lt [int]($height * 0.13)
        $inFooterChrome = $y -gt [int]($height * 0.88)
        if (-not $inTopChrome -and -not $inFooterChrome) { continue }
        $startX = if ($inTopChrome) { [int]($width * 0.84) } else { [int]($width * 0.60) }
        for ($x = $startX; $x -lt $width; $x += 2) {
          $pixel = $bitmap.GetPixel($x, $y)
          if ($pixel.R -gt 235 -and $pixel.G -gt 235 -and $pixel.B -gt 235) { $nearWhite++ }
        }
      }
      for ($y = [int]($height * 0.13); $y -lt [int]($height * 0.88); $y += 4) {
        for ($x = [int]($width * 0.40); $x -lt $width; $x += 4) {
          $pixel = $bitmap.GetPixel($x, $y)
          if ($pixel.R -gt 235 -and $pixel.G -gt 235 -and $pixel.B -gt 235) { $contentNearWhite++ }
        }
      }
      if ($nearWhite -gt 800) {
        throw "System-white installer chrome detected in ${Name}: ${nearWhite} sampled pixels"
      }
      if ($contentNearWhite -gt 1800) {
        throw "System-white installer page detected in ${Name}: ${contentNearWhite} sampled pixels"
      }
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  function Assert-LiveProgress {
    $percent = [NinetyPreviewWin32]::FindDescendantById($window, 1226)
    if ($percent -eq [IntPtr]::Zero) { throw "Installer percentage control was not found" }
    $value = [NinetyPreviewWin32]::ReadText($percent)
    if ($value -notmatch '^([1-9][0-9]?|100)%$') {
      throw "Installer percentage is not live: '$value'"
    }
  }

  function Click-InstallerControl([int]$Id) {
    $control = [NinetyPreviewWin32]::FindDescendantById($window, $Id)
    if ($control -eq [IntPtr]::Zero) { throw "Installer control $Id was not found" }
    $controlRect = New-Object NinetyPreviewWin32+RECT
    if (-not [NinetyPreviewWin32]::GetWindowRect($control, [ref]$controlRect)) {
      throw "GetWindowRect failed for installer control $Id"
    }
    $x = [int](($controlRect.Left + $controlRect.Right) / 2)
    $y = [int](($controlRect.Top + $controlRect.Bottom) / 2)
    Click-ScreenPoint $x $y
  }

  function Click-ScreenPoint([int]$x, [int]$y) {
    [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
    [NinetyPreviewWin32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 160
    [NinetyPreviewWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    [NinetyPreviewWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }

  function Find-NonClientPoint([int]$hitCode, [int]$left, [int]$top, [int]$right, [int]$bottom) {
    for ($y = $top; $y -lt [Math]::Min($bottom, $top + 64); $y += 2) {
      for ($x = [Math]::Max($left, $right - 240); $x -lt $right; $x += 2) {
        $packed = (($y -band 0xFFFF) -shl 16) -bor ($x -band 0xFFFF)
        $hit = [NinetyPreviewWin32]::SendMessage(
          $window,
          0x0084,
          [IntPtr]::Zero,
          [IntPtr]::new([int64]$packed)
        ).ToInt32()
        if ($hit -eq $hitCode) { return @($x, $y) }
      }
    }
    return $null
  }

  function Send-Enter {
    [NinetyPreviewWin32]::PostMessage($window, 0x0100, [UIntPtr]0x0D, [IntPtr]::Zero) | Out-Null
    [NinetyPreviewWin32]::PostMessage($window, 0x0101, [UIntPtr]0x0D, [IntPtr]::Zero) | Out-Null
  }

  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Seconds 2
  Save-InstallerWindow "00-initial.png"

  # The production regression affected real left-clicks while Enter still
  # worked. Exercise the bitmap caption controls before taking screenshots.
  Click-InstallerControl 1205
  Start-Sleep -Milliseconds 500
  if (-not [NinetyPreviewWin32]::IsIconic($window)) {
    throw "Installer minimize control ignored a real left-click"
  }
  [NinetyPreviewWin32]::ShowWindow($window, 9) | Out-Null # SW_RESTORE
  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 500
  Save-InstallerWindow "00-before-drag.png"

  # Exercise real frameless-window dragging. Hosted runners occasionally lose
  # one synthetic mouse-down during startup, so retry independent gestures and
  # keep collecting visual evidence even if all attempts fail.
  $originalRect = Get-InstallerRect
  $dragPassed = $false
  foreach ($attempt in 0..2) {
    $before = Get-InstallerRect
    [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
    $startX = $before.Left + 420 + ($attempt * 35)
    $startY = $before.Top + 34
    [NinetyPreviewWin32]::SetCursorPos($startX, $startY) | Out-Null
    Start-Sleep -Milliseconds 250
    [NinetyPreviewWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 700
    foreach ($delta in 8, 16, 24, 32, 40) {
      [NinetyPreviewWin32]::SetCursorPos($startX + $delta, $startY + $delta) | Out-Null
      Start-Sleep -Milliseconds 160
    }
    [NinetyPreviewWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
    $after = Get-InstallerRect
    if ($after.Left -ne $before.Left -or $after.Top -ne $before.Top) {
      $dragPassed = $true
      break
    }
  }
  # A successful drag can leave the lower edge behind the Windows taskbar.
  # Restore the original rectangle before visual pixel checks and captures.
  [NinetyPreviewWin32]::MoveWindow(
    $window,
    $originalRect.Left,
    $originalRect.Top,
    $originalRect.Right - $originalRect.Left,
    $originalRect.Bottom - $originalRect.Top,
    $true
  ) | Out-Null
  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 500

  Save-InstallerWindow "01-welcome.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "02-license.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "03-install-mode.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "04-maintenance.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 3
  Assert-LiveProgress
  Save-InstallerWindow "05-progress.png"
  Start-Sleep -Seconds 5
  Send-Enter
  Start-Sleep -Seconds 1
  Save-InstallerWindow "06-finish.png"
  Click-InstallerControl 1207
  if (-not $process.WaitForExit(5000)) {
    throw "Installer close control ignored a real left-click"
  }

  # Start once more to verify the footer Cancel control independently.
  $process = Start-Process -FilePath $Installer -PassThru
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $window = $process.MainWindowHandle
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Second installer window did not appear" }
  Click-InstallerControl 2
  if (-not $process.WaitForExit(5000)) {
    throw "Installer cancel control ignored a real left-click"
  }

  # Tauri updater uses /P /R and jumps straight into synchronous InstFiles.
  # Exercise the separate OS-managed OTA caption while that page is busy.
  $process = Start-Process -FilePath $Installer -ArgumentList "/P" -PassThru
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $window = $process.MainWindowHandle
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Passive OTA installer window did not appear" }
  Start-Sleep -Milliseconds 1400

  $style = [NinetyPreviewWin32]::GetWindowLong($window, -16)
  if (($style -band 0x00C00000) -ne 0x00C00000) {
    throw "Passive OTA installer has no native Windows caption"
  }
  foreach ($id in 1205, 1207) {
    $fakeCaption = [NinetyPreviewWin32]::FindDescendantById($window, $id)
    if ($fakeCaption -ne [IntPtr]::Zero -and [NinetyPreviewWin32]::IsWindowVisible($fakeCaption)) {
      throw "Passive OTA installer still exposes frozen custom caption control $id"
    }
  }
  $systemMenu = [NinetyPreviewWin32]::GetSystemMenu($window, $false)
  $closeState = [NinetyPreviewWin32]::GetMenuState($systemMenu, 0xF060, 0)
  if (($closeState -band 0x00000003) -eq 0) {
    throw "Passive OTA close action is not visibly disabled during file replacement"
  }
  Save-InstallerWindow "09-ota-progress.png"

  $otaOriginalRect = Get-InstallerRect
  $captionButtonHeight = [Math]::Max(24, [NinetyPreviewWin32]::GetSystemMetrics(31))
  $minimizePoint = Find-NonClientPoint 8 $otaOriginalRect.Left $otaOriginalRect.Top $otaOriginalRect.Right $otaOriginalRect.Bottom
  if (-not $minimizePoint) { throw "Passive OTA native minimize button hit target was not found" }
  Click-ScreenPoint $minimizePoint[0] $minimizePoint[1]
  Start-Sleep -Milliseconds 500
  if (-not [NinetyPreviewWin32]::IsIconic($window)) {
    throw "Passive OTA native minimize button ignored a real left-click"
  }
  [NinetyPreviewWin32]::ShowWindow($window, 9) | Out-Null
  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Start-Sleep -Milliseconds 400

  $before = Get-InstallerRect
  $startX = [int](($before.Left + $before.Right) / 2)
  $startY = $before.Top + [int]($captionButtonHeight / 2)
  [NinetyPreviewWin32]::SetCursorPos($startX, $startY) | Out-Null
  [NinetyPreviewWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  foreach ($delta in 10, 20, 30, 40) {
    [NinetyPreviewWin32]::SetCursorPos($startX + $delta, $startY + $delta) | Out-Null
    Start-Sleep -Milliseconds 100
  }
  [NinetyPreviewWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 400
  $after = Get-InstallerRect
  if ($after.Left -eq $before.Left -and $after.Top -eq $before.Top) {
    throw "Passive OTA window did not move from a real native-caption drag"
  }
  [NinetyPreviewWin32]::MoveWindow(
    $window,
    $otaOriginalRect.Left,
    $otaOriginalRect.Top,
    $otaOriginalRect.Right - $otaOriginalRect.Left,
    $otaOriginalRect.Bottom - $otaOriginalRect.Top,
    $true
  ) | Out-Null
  if (-not $process.WaitForExit(15000)) {
    throw "Passive OTA installer did not finish and close automatically"
  }

  $uninstaller = Join-Path $env:TEMP "NinetySmoke\uninstall.exe"
  if (-not (Test-Path $uninstaller)) { throw "Smoke uninstaller was not created" }
  $process = Start-Process -FilePath $uninstaller -PassThru
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $window = $process.MainWindowHandle
    if ($window -eq [IntPtr]::Zero) {
      # NSIS uninstallers relaunch from a temporary Au_.exe copy, so the
      # process returned by Start-Process can exit before the real UI appears.
      $window = [NinetyPreviewWin32]::FindKuroganeWindow()
    }
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Uninstaller window did not appear" }
  Start-Sleep -Seconds 1
  Save-InstallerWindow "07-uninstall-confirm.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 3
  Save-InstallerWindow "08-uninstall-finish.png"
  Click-InstallerControl 1
  $deadline = (Get-Date).AddSeconds(10)
  while ([NinetyPreviewWin32]::IsWindow($window) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
  }
  if ([NinetyPreviewWin32]::IsWindow($window)) {
    throw "Uninstaller remove control ignored a real left-click"
  }
  if (-not $dragPassed) {
    throw "Frameless installer window did not move after three independent drag gestures"
  }
} finally {
  if ($window -ne [IntPtr]::Zero -and [NinetyPreviewWin32]::IsWindow($window)) {
    [NinetyPreviewWin32]::PostMessage($window, 0x0010, [UIntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  }
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
}
