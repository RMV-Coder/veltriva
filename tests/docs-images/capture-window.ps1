# Captures a window to PNG for the README's images (M6.4, tests/docs-images/capture.spec.ts).
# PrintWindow with PW_RENDERFULLCONTENT renders Chromium's GPU-composited content even when other
# windows cover it; the image is cropped to the window's visible frame (DWM's extended frame
# bounds, without the invisible resize border), in physical pixels.
#
#   capture-window.ps1 -Hwnd <handle> -Out shot.png
#   capture-window.ps1 -Hwnd <handle> -Out <folder> -FramesUntil <stop file> [-IntervalMs 100]
#     writes frame-00000.png, ... until the stop file exists, then frames.json (count, seconds)
param(
  [Parameter(Mandatory = $true)] [string] $Hwnd,
  [Parameter(Mandatory = $true)] [string] $Out,
  [string] $FramesUntil = '',
  [int] $IntervalMs = 100
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
if (-not ('VeltrivaCapture' -as [type])) {
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class VeltrivaCapture {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
  const uint PW_RENDERFULLCONTENT = 2;
  const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  public static void Save(IntPtr hWnd, string path) {
    // Physical pixels: per-monitor DPI aware (v2) for this thread.
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    RECT window; GetWindowRect(hWnd, out window);
    RECT frame;
    if (DwmGetWindowAttribute(hWnd, DWMWA_EXTENDED_FRAME_BOUNDS, out frame, Marshal.SizeOf(typeof(RECT))) != 0) { frame = window; }
    int width = window.Right - window.Left, height = window.Bottom - window.Top;
    using (var full = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
      using (var g = Graphics.FromImage(full)) {
        IntPtr hdc = g.GetHdc();
        try { PrintWindow(hWnd, hdc, PW_RENDERFULLCONTENT); } finally { g.ReleaseHdc(hdc); }
      }
      var crop = new Rectangle(frame.Left - window.Left, frame.Top - window.Top, frame.Right - frame.Left, frame.Bottom - frame.Top);
      using (var visible = full.Clone(crop, PixelFormat.Format24bppRgb)) { visible.Save(path, ImageFormat.Png); }
    }
  }
}
'@
}

$handle = [IntPtr][long]$Hwnd
if ($FramesUntil -eq '') {
  [VeltrivaCapture]::Save($handle, $Out)
  exit 0
}

New-Item -ItemType Directory -Force $Out | Out-Null
$started = Get-Date
$count = 0
while (-not (Test-Path $FramesUntil)) {
  $tick = Get-Date
  [VeltrivaCapture]::Save($handle, (Join-Path $Out ('frame-{0:D5}.png' -f $count)))
  $count += 1
  $spent = ((Get-Date) - $tick).TotalMilliseconds
  if ($spent -lt $IntervalMs) { Start-Sleep -Milliseconds ([int]($IntervalMs - $spent)) }
}
$seconds = ((Get-Date) - $started).TotalSeconds
@{ frames = $count; seconds = $seconds } | ConvertTo-Json | Set-Content -Encoding ascii (Join-Path $Out 'frames.json')
