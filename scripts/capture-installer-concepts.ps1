param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$Installer = (Resolve-Path $Installer).Path

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NinetyConceptWin32 {
  public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hdc);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
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
  public static IntPtr FindConceptWindow() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr param) {
      if (IsWindowVisible(window) &&
          GetDlgItem(window, 1205) != IntPtr.Zero &&
          GetDlgItem(window, 1213) != IntPtr.Zero &&
          GetDlgItem(window, 1207) != IntPtr.Zero) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool ContainsText(IntPtr parent, string expected) {
    bool found = false;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(512);
      GetWindowText(child, value, value.Capacity);
      if (value.ToString().Contains(expected)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool HasVisibleClass(IntPtr parent, string expectedClass) {
    bool found = false;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(128);
      GetClassName(child, value, value.Capacity);
      if (IsWindowVisible(child) && string.Equals(value.ToString(), expectedClass, StringComparison.OrdinalIgnoreCase)) {
        found = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static int CountVisibleClass(IntPtr parent, string expectedClass) {
    int count = 0;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(128);
      GetClassName(child, value, value.Capacity);
      if (IsWindowVisible(child) && string.Equals(value.ToString(), expectedClass, StringComparison.OrdinalIgnoreCase)) {
        count++;
      }
      return true;
    }, IntPtr.Zero);
    return count;
  }
  public static IntPtr FindVisibleClassAtIndex(IntPtr parent, string expectedClass, int expectedIndex) {
    IntPtr found = IntPtr.Zero;
    int index = 0;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(128);
      GetClassName(child, value, value.Capacity);
      if (IsWindowVisible(child) && string.Equals(value.ToString(), expectedClass, StringComparison.OrdinalIgnoreCase)) {
        if (index == expectedIndex) {
          found = child;
          return false;
        }
        index++;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool HasInvalidLanguagePushCard(IntPtr parent) {
    bool invalid = false;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(128);
      GetClassName(child, value, value.Capacity);
      if (!IsWindowVisible(child) || !string.Equals(value.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) {
        return true;
      }
      int style = GetWindowLong(child, -16); // GWL_STYLE
      bool isAutoRadio = (style & 0x0000000F) == 0x00000009;
      bool isPushLike = (style & 0x00001000) != 0;
      bool isFlat = (style & 0x00008000) != 0;
      if (!isAutoRadio || !isPushLike || !isFlat) {
        invalid = true;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return invalid;
  }
  public static IntPtr FindVisiblePage(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var value = new System.Text.StringBuilder(128);
      GetClassName(child, value, value.Capacity);
      if (IsWindowVisible(child) && value.ToString() == "#32770") {
        found = child;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string FindStaticTextOverflow(IntPtr parent) {
    string issue = null;
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

$pages = @(
  @{ File = "c-01-language.png";    Marker = "SIGNAL MATRIX / LOCALE"; Title = "Installer language / Язык установщика"; HasEdit = $false; Counter = "STEP 01 / 05" },
  @{ File = "c-02-scope.png";       Marker = "CONCEPT C"; Title = "Application access";       HasEdit = $false; Counter = "STEP 02 / 05" },
  @{ File = "c-03-target.png";      Marker = "CONCEPT C"; Title = "Deployment target";        HasEdit = $true;  Counter = "STEP 03 / 05" },
  @{ File = "c-04-manifest.png";    Marker = "CONCEPT C"; Title = "Open-source manifest";     HasEdit = $false; Counter = "STEP 04 / 05" },
  @{ File = "c-05-maintenance.png"; Marker = "CONCEPT C"; Title = "Installer operation";      HasEdit = $false; Counter = "STEP 05 / 05" },
  @{ File = "a-01-scope.png";       Marker = "CONCEPT A"; Title = "Application access";       HasEdit = $false },
  @{ File = "a-02-target.png";      Marker = "CONCEPT A"; Title = "Deployment target";        HasEdit = $true  },
  @{ File = "a-03-manifest.png";    Marker = "CONCEPT A"; Title = "Open-source manifest";     HasEdit = $false },
  @{ File = "a-04-maintenance.png"; Marker = "CONCEPT A"; Title = "Installer operation";      HasEdit = $false },
  @{ File = "b-01-scope.png";       Marker = "CONCEPT B"; Title = "Application access";       HasEdit = $false },
  @{ File = "b-02-target.png";      Marker = "CONCEPT B"; Title = "Deployment target";        HasEdit = $true  },
  @{ File = "b-03-manifest.png";    Marker = "CONCEPT B"; Title = "Open-source manifest";     HasEdit = $false },
  @{ File = "b-04-maintenance.png"; Marker = "CONCEPT B"; Title = "Installer operation";      HasEdit = $false }
)

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$process = Start-Process -FilePath $Installer -PassThru

try {
  $window = [IntPtr]::Zero
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $window = [NinetyConceptWin32]::FindConceptWindow()
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Concept gallery window did not appear" }

  function Get-WindowRect([IntPtr]$handle) {
    $rect = New-Object NinetyConceptWin32+RECT
    if (-not [NinetyConceptWin32]::GetWindowRect($handle, [ref]$rect)) {
      throw "GetWindowRect failed"
    }
    return $rect
  }

  function Click-Control([int]$id) {
    $control = [NinetyConceptWin32]::FindDescendantById($window, $id)
    if ($control -eq [IntPtr]::Zero) { throw "Concept control $id was not found" }
    $rect = Get-WindowRect $control
    $x = [int](($rect.Left + $rect.Right) / 2)
    $y = [int](($rect.Top + $rect.Bottom) / 2)
    [NinetyConceptWin32]::SetForegroundWindow($window) | Out-Null
    [NinetyConceptWin32]::SetCursorPos($x, $y) | Out-Null
    Start-Sleep -Milliseconds 120
    [NinetyConceptWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    [NinetyConceptWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }

  function Activate-LanguageCard([int]$index) {
    $pageWindow = [NinetyConceptWin32]::FindVisiblePage($window)
    if ($pageWindow -eq [IntPtr]::Zero) { throw "Visible language page was not found" }
    $control = [NinetyConceptWin32]::FindVisibleClassAtIndex($pageWindow, "Button", $index)
    if ($control -eq [IntPtr]::Zero) { throw "Language push-card $index was not found" }
    # Exercise the native push-card activation path directly. Real pointer
    # clicks remain covered by the production shell capture; GitHub's headless
    # desktop does not route global pointer input into nested custom pages.
    [NinetyConceptWin32]::SendMessage($control, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null # BM_CLICK
  }

  function Wait-ForPage([hashtable]$page) {
    $deadline = (Get-Date).AddSeconds(8)
    do {
      Start-Sleep -Milliseconds 120
      $hasMarker = [NinetyConceptWin32]::ContainsText($window, $page.Marker)
      $hasTitle = [NinetyConceptWin32]::ContainsText($window, $page.Title)
      $hasCounter = -not $page.Counter -or [NinetyConceptWin32]::ContainsText($window, $page.Counter)
    } until (($hasMarker -and $hasTitle -and $hasCounter) -or (Get-Date) -gt $deadline)
    if (-not $hasMarker -or -not $hasTitle -or -not $hasCounter) {
      throw "Concept page did not appear: $($page.File) (marker=$hasMarker, title=$hasTitle, counter=$hasCounter)"
    }
  }

  function Save-Page([hashtable]$page) {
    $rect = Get-WindowRect $window
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 900 -or $height -lt 600) {
      throw "Unexpected concept gallery size: ${width}x${height}"
    }
    $bitmap = New-Object System.Drawing.Bitmap($width, $height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
      $bitmap.Save((Join-Path $OutputDirectory $page.File), [System.Drawing.Imaging.ImageFormat]::Png)
      $nearWhite = 0
      for ($y = 70; $y -lt ($height - 70); $y += 4) {
        for ($x = [int]($width * 0.39); $x -lt $width; $x += 4) {
          $pixel = $bitmap.GetPixel($x, $y)
          if ($pixel.R -gt 238 -and $pixel.G -gt 238 -and $pixel.B -gt 238) { $nearWhite++ }
        }
      }
      if ($nearWhite -gt 1200) {
        throw "System-white default surface detected in $($page.File): $nearWhite sampled pixels"
      }
    } finally {
      $graphics.Dispose()
      $bitmap.Dispose()
    }
  }

  for ($index = 0; $index -lt $pages.Count; $index++) {
    $page = $pages[$index]
    Wait-ForPage $page
    $pageWindow = [NinetyConceptWin32]::FindVisiblePage($window)
    if ($pageWindow -eq [IntPtr]::Zero) { throw "Visible concept page was not found: $($page.File)" }
    $hasEdit = [NinetyConceptWin32]::HasVisibleClass($pageWindow, "Edit")
    if ($hasEdit -ne $page.HasEdit) {
      throw "Native path edit contract mismatch on $($page.File): expected=$($page.HasEdit), actual=$hasEdit"
    }
    $buttonCount = [NinetyConceptWin32]::CountVisibleClass($pageWindow, "Button")
    if ($page.File -eq "c-01-language.png") {
      if ($buttonCount -ne 2) {
        throw "Language matrix must expose exactly two interactive push-cards, found $buttonCount"
      }
      if ([NinetyConceptWin32]::HasInvalidLanguagePushCard($pageWindow)) {
        throw "Language matrix contains a stock button instead of a flat push-card"
      }
    } elseif ($buttonCount -ne 0) {
      throw "Stock radio/checkbox/button leaked into concept canvas: $($page.File)"
    }
    if ($page.File.StartsWith("c-")) {
      $overflow = [NinetyConceptWin32]::FindStaticTextOverflow($pageWindow)
      if ($overflow) { throw "Signal Matrix text overflow on $($page.File): $overflow" }
    }
    Start-Sleep -Milliseconds 250
    Save-Page $page
    if ($page.File -eq "c-01-language.png") {
      Activate-LanguageCard 1
      $languageDeadline = (Get-Date).AddSeconds(3)
      do {
        Start-Sleep -Milliseconds 100
        $russianSelected = [NinetyConceptWin32]::ContainsText($window, "ВЫБРАНО")
      } until ($russianSelected -or (Get-Date) -gt $languageDeadline)
      if (-not $russianSelected) {
        Activate-LanguageCard 1
        $languageDeadline = (Get-Date).AddSeconds(3)
        do {
          Start-Sleep -Milliseconds 100
          $russianSelected = [NinetyConceptWin32]::ContainsText($window, "ВЫБРАНО")
        } until ($russianSelected -or (Get-Date) -gt $languageDeadline)
      }
      if (-not $russianSelected) { throw "Russian language card did not switch state" }
    }
    if ($index -lt ($pages.Count - 1)) {
      Click-Control 1213
    }
  }

  Click-Control 1207
  if (-not $process.WaitForExit(8000)) {
    throw "Concept gallery did not close from a real left-click"
  }
} finally {
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
}
