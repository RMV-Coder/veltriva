# The installer on this machine, end to end (M6.3, docs/distribution/releasing.md):
#   install, launch, uninstall keeping the profile, reinstall, launch, optionally an upgrade to a
#   newer installer, uninstall removing the profile, then the scripted uninstalls (/S keeps the
#   profile without asking, /S --delete-app-data removes it).
# The uninstaller's two questions ("Are you sure?", then "Also remove your Veltriva data?") are
# answered by pressing their buttons, so the real interactive path runs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\installer-test.ps1 -Installer release\Veltriva-Browser-Setup-0.1.0.exe
#   ... -Installer <older.exe> -Upgrade <newer.exe>      also checks an upgrade over an install
#
# Your profile (%APPDATA%\Veltriva) is renamed aside first, to %APPDATA%\Veltriva.installer-test-aside,
# and put back at the end whatever happens; any install this script made is removed at the end.
# It refuses to run while a Veltriva process exists (it would be yours), while Veltriva is
# installed for this user, or while an earlier run's aside folder still exists.
param(
  [Parameter(Mandatory = $true)] [string] $Installer,
  [string] $Upgrade = '',
  [switch] $SkipSilent
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$Installer = (Resolve-Path $Installer).Path
if ($Upgrade -ne '') { $Upgrade = (Resolve-Path $Upgrade).Path }
$appProfile = Join-Path $env:APPDATA 'Veltriva'
$aside = Join-Path $env:APPDATA 'Veltriva.installer-test-aside'
$uninstallTitle = 'Veltriva Browser Uninstall'
$results = [ordered]@{}

# Win32: a process's dialogs (#32770) with their controls, and pressing a button by its text
# (BM_CLICK). UI Automation shows NSIS message boxes' buttons as panes, so it isn't used.
if (-not ('VeltrivaDialogs' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class VeltrivaDialogs {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  const uint BM_CLICK = 0x00F5;

  static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  static string Text(IntPtr h) { var s = new StringBuilder(4096); GetWindowText(h, s, 4096); return s.ToString(); }

  public class Control { public IntPtr Handle; public string ClassName; public string Text; }
  public class Dialog { public string Title; public List<Control> Controls = new List<Control>(); }

  /// The visible dialogs with this title.
  public static List<Dialog> Find(string title) {
    var found = new List<Dialog>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || Class(h) != "#32770" || Text(h) != title) return true;
      var d = new Dialog { Title = title };
      EnumChildWindows(h, (c, l2) => { d.Controls.Add(new Control { Handle = c, ClassName = Class(c), Text = Text(c) }); return true; }, IntPtr.Zero);
      found.Add(d);
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static void Click(IntPtr button) { SendMessage(button, BM_CLICK, IntPtr.Zero, IntPtr.Zero); }
}
'@
}

function Get-UninstallDialogs { return [VeltrivaDialogs]::Find($uninstallTitle) }

function Get-DialogMessage($dialog) {
  return (($dialog.Controls | Where-Object { $_.ClassName -eq 'Static' -and $_.Text -ne '' } | ForEach-Object Text) -join ' ') -replace '\s+', ' '
}

function Invoke-DialogButton($dialog, [string] $Text) {
  $button = $dialog.Controls | Where-Object { $_.ClassName -eq 'Button' -and ($_.Text -replace '&', '') -eq $Text } | Select-Object -First 1
  if ($null -eq $button) { throw "The dialog '$($dialog.Title)' has no '$Text' button" }
  [VeltrivaDialogs]::Click($button.Handle)
}

function Get-UninstallEntry {
  $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue
  foreach ($key in $keys) {
    $p = Get-ItemProperty $key.PSPath
    if ($p.DisplayName -like 'Veltriva*') { return $p }
  }
  return $null
}

# The install folder: the uninstaller's own folder (the one-click installer writes no InstallLocation).
function Get-InstallDir($entry) {
  return Split-Path -Parent ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
}

# The running uninstallers: NSIS copies the uninstaller to %TEMP%\~nsu.tmp and runs the copy.
function Get-Uninstallers { return @(Get-Process | Where-Object { $_.Path -like '*\~nsu.tmp\Un_*.exe' }) }

function Get-ShortcutFacts([string] $path) {
  if (-not (Test-Path $path)) { return 'missing' }
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)
  $folder = (New-Object -ComObject Shell.Application).NameSpace((Split-Path $path))
  $aumid = $folder.ParseName((Split-Path $path -Leaf)).ExtendedProperty('System.AppUserModel.ID')
  return "target=$($link.TargetPath); aumid=$aumid"
}

# Waits for the uninstaller's dialog whose message matches $Like, and presses $Answer.
function Invoke-UninstallAnswer([string] $Like, [string] $Answer, [int] $TimeoutSeconds = 60) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($dialog in (Get-UninstallDialogs)) {
      $message = Get-DialogMessage $dialog
      if ($message -notlike $Like) { continue }
      $buttons = ($dialog.Controls | Where-Object ClassName -eq 'Button' | ForEach-Object { $_.Text -replace '&', '' }) -join '/'
      Invoke-DialogButton $dialog $Answer
      return "asked '$message' [$buttons], pressed $Answer"
    }
    Start-Sleep -Milliseconds 300
  }
  return 'NOT ASKED'
}

# An uninstaller left waiting by a failed step: cancel it, or keep the profile, then stop it.
function Stop-StrayUninstallers {
  foreach ($dialog in (Get-UninstallDialogs)) {
    $message = Get-DialogMessage $dialog
    if ($message -like '*Are you sure*') { Invoke-DialogButton $dialog 'Cancel' }
    elseif ($message -like '*remove your Veltriva data*') { Invoke-DialogButton $dialog 'No' }
  }
  Start-Sleep -Seconds 3
  Get-Uninstallers | Stop-Process -Force -ErrorAction SilentlyContinue
}

function Install([string] $path, [string] $label) {
  $p = Start-Process -FilePath $path -ArgumentList '/S' -PassThru -Wait
  $entry = Get-UninstallEntry
  $results["$label exit"] = $p.ExitCode
  $results["$label entry"] = if ($null -eq $entry) { 'none' } else { "$($entry.DisplayName) $($entry.DisplayVersion) at $(Get-InstallDir $entry)" }
  return $entry
}

function Launch([string] $exe, [string] $label) {
  $started = Get-Date
  $proc = Start-Process -FilePath $exe -PassThru
  $windowAt = $null
  for ($i = 0; $i -lt 300; $i++) {
    Start-Sleep -Milliseconds 100
    $proc.Refresh()
    if ($proc.MainWindowHandle -ne 0) { $windowAt = (Get-Date) - $started; break }
  }
  Start-Sleep -Seconds 4
  $proc.Refresh()
  [void]$proc.CloseMainWindow()
  if (-not $proc.WaitForExit(30000)) { throw "$label did not exit within 30 s of closing its window" }
  Start-Sleep -Seconds 2
  $results["$label window s"] = if ($null -eq $windowAt) { 'never' } else { [math]::Round($windowAt.TotalSeconds, 1) }
  $results["$label exit code"] = $proc.ExitCode
  $results["$label left running"] = @(Get-Process Veltriva -ErrorAction SilentlyContinue).Count
  $results["$label profile items"] = @(Get-ChildItem -Force $appProfile -ErrorAction SilentlyContinue).Count
}

function Get-RemovalFacts($installDir, [string] $label) {
  $results["$label app gone"] = -not (Test-Path (Join-Path $installDir 'Veltriva.exe'))
  $results["$label install folder gone"] = -not (Test-Path $installDir)
  $results["$label entry gone"] = ($null -eq (Get-UninstallEntry))
  $results["$label start-menu shortcut"] = Get-ShortcutFacts $startMenuLink
  $results["$label desktop shortcut"] = Get-ShortcutFacts $desktopLink
  $results["$label profile kept"] = Test-Path $appProfile
}

# The uninstall a person runs: the standard confirmation, then ours (build/installer.nsh).
function Uninstall-Interactive([string] $answer, [string] $label) {
  $entry = Get-UninstallEntry
  $exe = ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
  $uninstallArgs = ($entry.UninstallString -replace '^"[^"]+"\s*', '')
  $installDir = Get-InstallDir $entry
  $p = Start-Process -FilePath $exe -ArgumentList $uninstallArgs -PassThru
  $results["$label confirm"] = Invoke-UninstallAnswer '*Are you sure*' 'OK'
  $results["$label question"] = Invoke-UninstallAnswer '*remove your Veltriva data*' $answer
  $p.WaitForExit(120000) | Out-Null
  for ($i = 0; $i -lt 240 -and (Get-Uninstallers).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
  $results["$label uninstaller finished"] = ((Get-Uninstallers).Count -eq 0)
  Start-Sleep -Seconds 2
  Get-RemovalFacts $installDir $label
}

# A scripted uninstall (/S, plus $extra): it must finish without showing any dialog.
function Uninstall-Silent([string] $extra, [string] $label) {
  $entry = Get-UninstallEntry
  $exe = ($entry.UninstallString -replace '^"([^"]+)".*$', '$1')
  $uninstallArgs = ($entry.UninstallString -replace '^"[^"]+"\s*', '') + " /S $extra"
  $installDir = Get-InstallDir $entry
  $p = Start-Process -FilePath $exe -ArgumentList $uninstallArgs -PassThru
  $dialogs = @()
  for ($i = 0; $i -lt 240; $i++) {
    Start-Sleep -Milliseconds 500
    $dialogs += @(Get-UninstallDialogs | ForEach-Object { Get-DialogMessage $_ })
    if ($p.HasExited -and (Get-Uninstallers).Count -eq 0) { break }
  }
  Start-Sleep -Seconds 2
  $results["$label dialogs shown"] = if ($dialogs.Count -eq 0) { 'none' } else { ($dialogs | Select-Object -Unique) -join ' | ' }
  Get-RemovalFacts $installDir $label
}

if (Get-Process Veltriva -ErrorAction SilentlyContinue) { throw 'A Veltriva process is running: not touching its profile.' }
if ($null -ne (Get-UninstallEntry)) { throw 'Veltriva is already installed for this user: not touching it.' }
if (Test-Path $aside) { throw "$aside exists: an earlier run did not finish; put it back as $appProfile by hand first." }
$startMenuLink = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Veltriva Browser.lnk'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Veltriva Browser.lnk'

$hadProfile = Test-Path $appProfile
$before = if ($hadProfile) { @(Get-ChildItem -Force $appProfile).Count } else { 0 }
if ($hadProfile) { Rename-Item $appProfile $aside }
try {
  # 1. Install, and what it put where.
  $entry = Install $Installer 'install 1'
  $dir = Get-InstallDir $entry
  $exe = Join-Path $dir 'Veltriva.exe'
  $results['installed exe'] = Test-Path $exe
  $results['uninstaller'] = $entry.UninstallString
  $results['start-menu shortcut'] = Get-ShortcutFacts $startMenuLink
  $results['desktop shortcut'] = Get-ShortcutFacts $desktopLink
  $results['license files'] = (@('resources\LICENSE.txt', 'resources\THIRD_PARTY_NOTICES.txt', 'LICENSE.electron.txt', 'LICENSES.chromium.html') | ForEach-Object { "$_=$(Test-Path (Join-Path $dir $_))" }) -join ', '
  Push-Location $repo
  try { $results['fuses'] = (node scripts/fuse-wire.mjs $exe | ConvertFrom-Json).fuses | ConvertTo-Json -Compress } finally { Pop-Location }

  # 2. Launch it on a new profile.
  Launch $exe 'launch 1'

  # 3. Uninstall, keeping the profile.
  Uninstall-Interactive 'No' 'uninstall keep'

  # 4. Reinstall: the kept profile is used again.
  $entry = Install $Installer 'install 2'
  Launch (Join-Path (Get-InstallDir $entry) 'Veltriva.exe') 'launch 2'

  # 5. Optionally, an upgrade over the install, then launch.
  if ($Upgrade -ne '') {
    $entry = Install $Upgrade 'upgrade'
    $results['upgrade profile kept'] = Test-Path $appProfile
    $results['upgrade dialogs left'] = @(Get-UninstallDialogs).Count
    Launch (Join-Path (Get-InstallDir $entry) 'Veltriva.exe') 'launch upgraded'
  }

  # 6. Uninstall, removing the profile.
  Uninstall-Interactive 'Yes' 'uninstall remove'

  # 7. Scripted uninstalls: /S keeps the profile without asking; --delete-app-data removes it.
  if (-not $SkipSilent) {
    $entry = Install $Installer 'install 3'
    Launch (Join-Path (Get-InstallDir $entry) 'Veltriva.exe') 'launch 3'
    Uninstall-Silent '' 'silent uninstall'
    $entry = Install $Installer 'install 4'
    Uninstall-Silent '--delete-app-data' 'silent uninstall --delete-app-data'
  }
}
finally {
  # Before your profile comes back: nothing may be left that could still delete it.
  Stop-StrayUninstallers
  if (Get-Process Veltriva -ErrorAction SilentlyContinue) { Get-Process Veltriva | Stop-Process -Force; Start-Sleep -Seconds 2 }
  $left = Get-UninstallEntry
  if ($null -ne $left) {
    $exe = ($left.UninstallString -replace '^"([^"]+)".*$', '$1')
    Start-Process -FilePath $exe -ArgumentList '/currentuser /S' -Wait
    for ($i = 0; $i -lt 120 -and (Get-Uninstallers).Count -gt 0; $i++) { Start-Sleep -Milliseconds 500 }
    Start-Sleep -Seconds 2
    $results['cleanup: silent uninstall'] = ($null -eq (Get-UninstallEntry))
  }
  if (Test-Path $appProfile) { Remove-Item -Recurse -Force $appProfile }
  if ($hadProfile) { Rename-Item $aside 'Veltriva' }
  $after = if (Test-Path $appProfile) { @(Get-ChildItem -Force $appProfile).Count } else { 0 }
  $results['profile restored'] = "$after items (was $before)"
  $results | Format-List
}
