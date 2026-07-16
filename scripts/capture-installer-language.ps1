param(
  [Parameter(Mandatory = $true)]
  [string]$Selector,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
$Selector = (Resolve-Path $Selector).Path

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NinetyLanguageWin32 {
  public delegate bool EnumWindowProc(IntPtr hWnd, IntPtr lParam);
  public delegate bool EnumChildProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumChildProc callback, IntPtr param);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hWnd, int id);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
  public static IntPtr FindKuroganeWindow() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr param) {
      if (IsWindowVisible(window) && GetDlgItem(window, 1205) != IntPtr.Zero && GetDlgItem(window, 1207) != IntPtr.Zero) {
        found = window;
        return false;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindVisiblePage(IntPtr parent) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var name = new System.Text.StringBuilder(64);
      GetClassName(child, name, name.Capacity);
      if (IsWindowVisible(child) && name.ToString() == "#32770") { found = child; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static IntPtr FindVisibleButton(IntPtr parent, int expectedIndex) {
    IntPtr found = IntPtr.Zero;
    int index = 0;
    EnumChildWindows(parent, delegate(IntPtr child, IntPtr param) {
      var name = new System.Text.StringBuilder(64);
      GetClassName(child, name, name.Capacity);
      if (IsWindowVisible(child) && string.Equals(name.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) {
        if (index == expectedIndex) { found = child; return false; }
        index++;
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
}
"@

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Wait-ForSelector([System.Diagnostics.Process]$process) {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 150
    $process.Refresh()
    $window = [NinetyLanguageWin32]::FindKuroganeWindow()
  } until ($window -ne [IntPtr]::Zero -or (Get-Date) -gt $deadline)
  if ($window -eq [IntPtr]::Zero) { throw "Language selector window did not appear" }
  return $window
}

function Save-Selector([IntPtr]$window, [string]$name) {
  $rect = New-Object NinetyLanguageWin32+RECT
  if (-not [NinetyLanguageWin32]::GetWindowRect($window, [ref]$rect)) { throw "GetWindowRect failed" }
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 900 -or $height -lt 600) { throw "Unexpected selector size: ${width}x${height}" }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
    $bitmap.Save((Join-Path $OutputDirectory $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $nearWhite = 0
    for ($y = 70; $y -lt ($height - 70); $y += 4) {
      for ($x = [int]($width * 0.39); $x -lt $width; $x += 4) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.R -gt 238 -and $pixel.G -gt 238 -and $pixel.B -gt 238) { $nearWhite++ }
      }
    }
    if ($nearWhite -gt 1200) { throw "System-white selector surface detected in ${name}" }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Click-Control([IntPtr]$window, [int]$id) {
  $control = [NinetyLanguageWin32]::GetDlgItem($window, $id)
  if ($control -eq [IntPtr]::Zero) { throw "Language selector control $id was not found" }
  $rect = New-Object NinetyLanguageWin32+RECT
  if (-not [NinetyLanguageWin32]::GetWindowRect($control, [ref]$rect)) { throw "GetWindowRect failed for $id" }
  [NinetyLanguageWin32]::SetForegroundWindow($window) | Out-Null
  [NinetyLanguageWin32]::SetCursorPos([int](($rect.Left + $rect.Right) / 2), [int](($rect.Top + $rect.Bottom) / 2)) | Out-Null
  Start-Sleep -Milliseconds 140
  [NinetyLanguageWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [NinetyLanguageWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

$process = Start-Process -FilePath $Selector -PassThru
try {
  $window = Wait-ForSelector $process
  $page = [NinetyLanguageWin32]::FindVisiblePage($window)
  if ($page -eq [IntPtr]::Zero) { throw "Visible language page was not found" }
  Save-Selector $window "00-language-selector-en.png"
  if (-not [NinetyLanguageWin32]::ContainsText($window, "Installer language / Язык установщика")) {
    throw "Bilingual selector title is missing"
  }
  $english = [NinetyLanguageWin32]::FindVisibleButton($page, 0)
  $russian = [NinetyLanguageWin32]::FindVisibleButton($page, 1)
  if ($english -eq [IntPtr]::Zero -or $russian -eq [IntPtr]::Zero) {
    throw "Two native language selectors were not found"
  }
  [NinetyLanguageWin32]::SendMessage($russian, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null # BM_CLICK
  Start-Sleep -Milliseconds 300
  if ([NinetyLanguageWin32]::SendMessage($russian, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 1) {
    throw "Russian language selector did not become checked"
  }
  Save-Selector $window "00-language-selector-ru.png"
  Click-Control $window 1
  if (-not $process.WaitForExit(5000)) { throw "Language selector did not close from Next" }
  if ($process.ExitCode -ne 11) { throw "Russian selector returned $($process.ExitCode), expected 11" }

  $process = Start-Process -FilePath $Selector -PassThru
  $window = Wait-ForSelector $process
  Click-Control $window 2
  if (-not $process.WaitForExit(5000)) { throw "Language selector did not close from Cancel" }
  if ($process.ExitCode -ne 12) { throw "Cancelled selector returned $($process.ExitCode), expected 12" }
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
