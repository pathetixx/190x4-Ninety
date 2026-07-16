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
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int DrawText(IntPtr hdc, string text, int count, ref RECT rect, uint format);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
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
  public static bool ContainsText(IntPtr parent, string expected) {
    bool found = false;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (!IsWindowVisible(child)) return true;
      string value = ReadText(child);
      if (value.Contains(expected)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindVisibleClass(IntPtr parent, string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (!IsWindowVisible(child)) return true;
      var value = new System.Text.StringBuilder(64);
      GetClassName(child, value, value.Capacity);
      if (value.ToString().StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindVisibleButton(IntPtr parent, int expectedIndex) {
    IntPtr found = IntPtr.Zero;
    int selectedTop = expectedIndex == 0 ? Int32.MaxValue : Int32.MinValue;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (!IsWindowVisible(child)) return true;
      var name = new System.Text.StringBuilder(64);
      GetClassName(child, name, name.Capacity);
      if (!string.Equals(name.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) return true;
      RECT rect;
      if (GetWindowRect(child, out rect) &&
          ((expectedIndex == 0 && rect.Top < selectedTop) || (expectedIndex != 0 && rect.Top > selectedTop))) {
        selectedTop = rect.Top;
        found = child;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string ClassName(IntPtr hWnd) {
    var value = new System.Text.StringBuilder(64);
    GetClassName(hWnd, value, value.Capacity);
    return value.ToString();
  }
  public static IntPtr FindTextPrefix(IntPtr parent, string prefix) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (!IsWindowVisible(child)) return true;
      string value = ReadText(child);
      if (value.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindVisiblePage(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(64);
      GetClassName(child, value, value.Capacity);
      if (IsWindowVisible(child) && value.ToString() == "#32770") { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string FindStaticTextOverflow(IntPtr parent) {
    string issue = null;
    RECT parentRect;
    if (!GetWindowRect(parent, out parentRect)) return null;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      if (!IsWindowVisible(child)) return true;
      var className = new System.Text.StringBuilder(64);
      GetClassName(child, className, className.Capacity);
      if (className.ToString() != "Static") return true;
      var value = new System.Text.StringBuilder(512);
      GetWindowText(child, value, value.Capacity);
      string text = value.ToString().Trim();
      if (text.Length == 0) return true;
      RECT windowRect;
      if (!GetWindowRect(child, out windowRect)) return true;
      // MUI keeps layout anchors outside the visible 560-DLU shell. They may
      // carry localized text and WS_VISIBLE while remaining entirely offscreen.
      if (windowRect.Right <= parentRect.Left || windowRect.Left >= parentRect.Right ||
          windowRect.Bottom <= parentRect.Top || windowRect.Top >= parentRect.Bottom) return true;
      int width = Math.Max(1, windowRect.Right - windowRect.Left);
      int height = Math.Max(1, windowRect.Bottom - windowRect.Top);
      IntPtr dc = GetDC(child);
      if (dc == IntPtr.Zero) return true;
      IntPtr font = SendMessage(child, 0x0031, IntPtr.Zero, IntPtr.Zero); // WM_GETFONT
      IntPtr previous = font == IntPtr.Zero ? IntPtr.Zero : SelectObject(dc, font);
      RECT measured = new RECT { Left = 0, Top = 0, Right = width, Bottom = 0 };
      DrawText(dc, text, -1, ref measured, 0x00000010 | 0x00000400 | 0x00000800);
      if (previous != IntPtr.Zero) SelectObject(dc, previous);
      ReleaseDC(child, dc);
      int neededHeight = measured.Bottom - measured.Top;
      if (neededHeight > height + 4) {
        issue = "'" + text.Replace("\r", " ").Replace("\n", " ") + "' needs " + neededHeight + "px, control has " + height + "px";
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return issue;
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

  function Refresh-InstallerWindow {
    $candidate = [NinetyPreviewWin32]::FindKuroganeWindow()
    if ($candidate -ne [IntPtr]::Zero) {
      $script:window = $candidate
      return
    }
    $process.Refresh()
    if ($process.HasExited) { throw "Installer exited unexpectedly with code $($process.ExitCode)" }
    throw "Kurogane installer window disappeared while the process was still running"
  }

  function Get-InstallerRect {
    $rect = New-Object NinetyPreviewWin32+RECT
    if (-not [NinetyPreviewWin32]::GetWindowRect($window, [ref]$rect)) {
      Refresh-InstallerWindow
      if (-not [NinetyPreviewWin32]::GetWindowRect($window, [ref]$rect)) {
        throw "GetWindowRect failed after reacquiring the Kurogane window"
      }
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

  function Assert-NoTextOverflow([string]$Name) {
    $overflow = [NinetyPreviewWin32]::FindStaticTextOverflow($window)
    if ($overflow) { throw "Installer text overflow on ${Name}: $overflow" }
  }

  function Assert-SignalCode([string]$Code, [string]$Name) {
    if (-not [NinetyPreviewWin32]::ContainsText($window, $Code)) {
      throw "Signal Matrix code $Code is missing on $Name"
    }
  }

  function Assert-BitmapButton([int]$Id, [string]$Name) {
    $control = [NinetyPreviewWin32]::FindDescendantById($window, $Id)
    if ($control -eq [IntPtr]::Zero) { throw "$Name button was not found" }
    $style = [NinetyPreviewWin32]::GetWindowLong($control, -16)
    if (($style -band 0x00000080) -ne 0x00000080) {
      throw "$Name fell back to a stock Windows button"
    }
    if ([NinetyPreviewWin32]::SendMessage($control, 0x00F6, [IntPtr]::Zero, [IntPtr]::Zero) -eq [IntPtr]::Zero) {
      throw "$Name has bitmap style but no Kurogane image"
    }
  }

  function Click-InstallerControl([int]$Id) {
    $control = [NinetyPreviewWin32]::FindDescendantById($window, $Id)
    if ($control -eq [IntPtr]::Zero) { throw "Installer control $Id was not found" }
    Click-InstallerHandle $control "control $Id"
  }

  function Click-InstallerHandle([IntPtr]$control, [string]$name) {
    $controlRect = New-Object NinetyPreviewWin32+RECT
    if (-not [NinetyPreviewWin32]::GetWindowRect($control, [ref]$controlRect)) {
      throw "GetWindowRect failed for installer $name"
    }
    $x = [int](($controlRect.Left + $controlRect.Right) / 2)
    $y = [int](($controlRect.Top + $controlRect.Bottom) / 2)
    Click-ScreenPoint $x $y
  }

  function Get-VisiblePage {
    $page = [NinetyPreviewWin32]::FindVisiblePage($window)
    if ($page -eq [IntPtr]::Zero) { throw "Visible installer page was not found" }
    return $page
  }

  function Get-SignalSelector([int]$index, [string]$name) {
    $control = [NinetyPreviewWin32]::FindVisibleButton((Get-VisiblePage), $index)
    if ($control -eq [IntPtr]::Zero) { throw "$name selector was not found" }
    return $control
  }

  function Assert-Checked([IntPtr]$control, [string]$name) {
    $checked = [NinetyPreviewWin32]::SendMessage($control, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($checked -ne 1) { throw "$name ignored a real left-click" }
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
  Save-InstallerWindow "02-install-mode.png"
  Assert-NoTextOverflow "install mode"
  Assert-SignalCode "190X4 / 02" "install mode"
  $modeSecondary = Get-SignalSelector 1 "All accounts"
  Click-InstallerHandle $modeSecondary "All accounts selector"
  Start-Sleep -Milliseconds 300
  Assert-Checked $modeSecondary "All accounts selector"
  $modePrimary = Get-SignalSelector 0 "Current account"
  Click-InstallerHandle $modePrimary "Current account selector"
  Start-Sleep -Milliseconds 300
  Assert-Checked $modePrimary "Current account selector"

  # Back and Next must both work through the same real LMB path users hit.
  Click-InstallerControl 3
  Start-Sleep -Milliseconds 600
  if ([NinetyPreviewWin32]::ContainsText($window, "190X4 / 02")) {
    throw "Installer Back control did not return from install mode"
  }
  Click-InstallerControl 1
  Start-Sleep -Milliseconds 600
  Assert-SignalCode "190X4 / 02" "install mode after Back"
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "03-target.png"
  Assert-NoTextOverflow "deployment target"
  Assert-SignalCode "190X4 / 03" "deployment target"
  Assert-BitmapButton 1001 "Deployment target change"
  $targetPage = Get-VisiblePage
  $stockTargetEdit = [NinetyPreviewWin32]::FindVisibleClass($targetPage, "Edit")
  if ($stockTargetEdit -ne [IntPtr]::Zero) {
    throw "Deployment target still exposes a stock Windows edit control"
  }
  $targetDisplay = [NinetyPreviewWin32]::FindDescendantById($targetPage, 1240)
  if ($targetDisplay -eq [IntPtr]::Zero -or -not [NinetyPreviewWin32]::IsWindowVisible($targetDisplay)) {
    throw "Custom deployment target display was not found"
  }
  $targetDisplayValue = [NinetyPreviewWin32]::ReadText($targetDisplay)
  if ([string]::IsNullOrWhiteSpace($targetDisplayValue)) {
    throw "Custom deployment target display contains no installation path"
  }

  # The custom Change bitmap must open the actual folder picker from LMB.
  Click-InstallerControl 1001
  $browseDeadline = (Get-Date).AddSeconds(5)
  do {
    Start-Sleep -Milliseconds 100
    $browseWindow = [NinetyPreviewWin32]::GetForegroundWindow()
  } until (($browseWindow -ne [IntPtr]::Zero -and $browseWindow -ne $window) -or (Get-Date) -gt $browseDeadline)
  if ($browseWindow -eq [IntPtr]::Zero -or $browseWindow -eq $window) {
    throw "Deployment target Change button ignored a real left-click"
  }
  if ([NinetyPreviewWin32]::ClassName($browseWindow) -ne "#32770") {
    throw "Deployment target Change opened an unexpected window class: $([NinetyPreviewWin32]::ClassName($browseWindow))"
  }
  [System.Windows.Forms.SendKeys]::SendWait("{ESC}")
  Start-Sleep -Milliseconds 500
  [NinetyPreviewWin32]::SetForegroundWindow($window) | Out-Null
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "04-license.png"
  Assert-NoTextOverflow "license"
  Assert-SignalCode "190X4 / 04" "license"
  $license = [NinetyPreviewWin32]::FindVisibleClass($window, "Edit")
  if ($license -eq [IntPtr]::Zero) { throw "Signal Matrix license body was not found" }
  $licenseStyle = [NinetyPreviewWin32]::GetWindowLong($license, -16)
  if (($licenseStyle -band 0x00200000) -ne 0) { throw "License still exposes a native vertical scrollbar" }
  $licensePosition = [NinetyPreviewWin32]::FindTextPrefix($window, "ПОЗИЦИЯ ЧТЕНИЯ")
  if ($licensePosition -eq [IntPtr]::Zero) { throw "Live license read position was not found" }
  $beforeLicensePosition = [NinetyPreviewWin32]::ReadText($licensePosition)
  $beforeLicenseLine = [NinetyPreviewWin32]::SendMessage($license, 0x00CE, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
  $licenseRect = New-Object NinetyPreviewWin32+RECT
  if (-not [NinetyPreviewWin32]::GetWindowRect($license, [ref]$licenseRect)) { throw "License body geometry was not available" }
  Click-ScreenPoint ([int](($licenseRect.Left + $licenseRect.Right) / 2)) ([int](($licenseRect.Top + $licenseRect.Bottom) / 2))
  [System.Windows.Forms.SendKeys]::SendWait("{PGDN}")
  Start-Sleep -Milliseconds 500
  $afterLicenseLine = [NinetyPreviewWin32]::SendMessage($license, 0x00CE, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
  $afterLicensePosition = [NinetyPreviewWin32]::ReadText($licensePosition)
  if ($afterLicenseLine -le $beforeLicenseLine -or $afterLicensePosition -eq $beforeLicensePosition) {
    throw "License Page Down did not move the custom read position ($beforeLicenseLine -> $afterLicenseLine, '$beforeLicensePosition' -> '$afterLicensePosition')"
  }
  Save-InstallerWindow "04-license-scrolled.png"
  Click-InstallerControl 1
  Start-Sleep -Seconds 1
  Save-InstallerWindow "05-maintenance.png"
  Assert-NoTextOverflow "maintenance"
  Assert-SignalCode "190X4 / 05" "maintenance"
  $maintenanceSecondary = Get-SignalSelector 1 "Remove Ninety"
  Click-InstallerHandle $maintenanceSecondary "Remove Ninety selector"
  Start-Sleep -Milliseconds 300
  Assert-Checked $maintenanceSecondary "Remove Ninety selector"
  $maintenancePrimary = Get-SignalSelector 0 "Repair Ninety"
  Click-InstallerHandle $maintenancePrimary "Repair Ninety selector"
  Start-Sleep -Milliseconds 300
  Assert-Checked $maintenancePrimary "Repair Ninety selector"
  Click-InstallerControl 1
  Start-Sleep -Seconds 3
  Assert-LiveProgress
  Save-InstallerWindow "06-progress.png"
  # MUI_FINISHPAGE_NOAUTOCLOSE keeps the completed progress page visible until
  # Next is activated. Do not send Enter on a fixed delay: a fast hosted runner
  # may already be on Finish, where the same key would close the process before
  # its visual evidence is captured.
  $finishDeadline = (Get-Date).AddSeconds(15)
  do {
    # The visible navigation HWND is the real NSIS button (ID 2); resource
    # anchor 1214 is intentionally hidden after its geometry is transferred.
    $footerCancel = [NinetyPreviewWin32]::FindDescendantById($window, 2)
    $finishVisible = $footerCancel -eq [IntPtr]::Zero -or -not [NinetyPreviewWin32]::IsWindowVisible($footerCancel)
    if ($finishVisible) { break }
    $percent = [NinetyPreviewWin32]::FindDescendantById($window, 1226)
    if ($percent -ne [IntPtr]::Zero -and [NinetyPreviewWin32]::ReadText($percent) -eq "100%") {
      $next = [NinetyPreviewWin32]::FindDescendantById($window, 1)
      if ($next -ne [IntPtr]::Zero) {
        [NinetyPreviewWin32]::PostMessage($next, 0x00F5, [UIntPtr]::Zero, [IntPtr]::Zero) | Out-Null
      }
    }
    Start-Sleep -Milliseconds 300
  } until ((Get-Date) -gt $finishDeadline)
  if (-not $finishVisible) { throw "Installer did not advance from completed progress to Finish" }
  Start-Sleep -Milliseconds 500
  Save-InstallerWindow "07-finish.png"
  Click-InstallerControl 1
  if (-not $process.WaitForExit(5000)) {
    throw "Installer Finish control ignored a real left-click"
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

  # Verify the custom caption Close independently on a stable wizard page.
  # NSIS intentionally owns Finish-page exit through button ID 1.
  $process = Start-Process -FilePath $Installer -PassThru
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $window = $process.MainWindowHandle
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Third installer window did not appear" }
  Click-InstallerControl 1207
  if (-not $process.WaitForExit(5000)) {
    throw "Installer close control ignored a real left-click"
  }

  # Exercise the real two-process startup seam. The language selector owns the
  # foreground first; after its LMB Next the waiting installer must reclaim it
  # instead of appearing behind Explorer or another application.
  $process = Start-Process -FilePath $Installer -ArgumentList "/SELECTLANG" -PassThru
  $window = [IntPtr]::Zero
  $selectorWindow = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 150
    $candidate = [NinetyPreviewWin32]::FindKuroganeWindow()
    if ($candidate -ne [IntPtr]::Zero -and [NinetyPreviewWin32]::ContainsText($candidate, "190X4 / 01")) {
      $selectorWindow = $candidate
    }
  } until ($selectorWindow -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($selectorWindow -eq [IntPtr]::Zero) { throw "Integrated language selector did not appear" }
  $window = $selectorWindow
  Click-InstallerControl 1

  $handoffWindow = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 100
    $candidate = [NinetyPreviewWin32]::FindKuroganeWindow()
    if ($candidate -ne [IntPtr]::Zero -and
        $candidate -ne $selectorWindow -and
        -not [NinetyPreviewWin32]::ContainsText($candidate, "190X4 / 01")) {
      $handoffWindow = $candidate
    }
  } until ($handoffWindow -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($handoffWindow -eq [IntPtr]::Zero) { throw "Installer did not continue after language selection" }
  $window = $handoffWindow
  Start-Sleep -Milliseconds 500
  if ([NinetyPreviewWin32]::GetForegroundWindow() -ne $window) {
    throw "Main installer did not reclaim the foreground after language selection"
  }
  $handoffExStyle = [NinetyPreviewWin32]::GetWindowLong($window, -20)
  if (($handoffExStyle -band 0x00000008) -ne 0) {
    throw "Foreground handoff left the installer permanently topmost"
  }
  Save-InstallerWindow "00-language-handoff.png"
  Click-InstallerControl 1207
  if (-not $process.WaitForExit(5000)) {
    throw "Installer did not close after the language handoff check"
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
  foreach ($id in 2, 1214) {
    $unsafeCancel = [NinetyPreviewWin32]::FindDescendantById($window, $id)
    if ($unsafeCancel -ne [IntPtr]::Zero -and [NinetyPreviewWin32]::IsWindowVisible($unsafeCancel)) {
      throw "Passive OTA installer still exposes unsafe cancel control $id"
    }
  }
  $systemMenu = [NinetyPreviewWin32]::GetSystemMenu($window, $false)
  $closeState = [NinetyPreviewWin32]::GetMenuState($systemMenu, 0xF060, 0)
  if (($closeState -band 0x00000003) -eq 0) {
    throw "Passive OTA close action is not visibly disabled during file replacement"
  }
  Save-InstallerWindow "08-ota-progress.png"

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
  Save-InstallerWindow "09-uninstall-confirm.png"
  Assert-NoTextOverflow "uninstall confirmation"
  Assert-SignalCode "190X4 / RM" "uninstall confirmation"
  $deleteDataToggle = Get-SignalSelector 0 "Remove settings and data"
  Click-InstallerHandle $deleteDataToggle "Remove settings and data toggle"
  Start-Sleep -Milliseconds 300
  Assert-Checked $deleteDataToggle "Remove settings and data toggle"
  Click-InstallerControl 1
  Start-Sleep -Seconds 3
  Save-InstallerWindow "10-uninstall-finish.png"
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
