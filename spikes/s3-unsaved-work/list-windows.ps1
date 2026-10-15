# Long-running helper for spike S3. Compiles a tiny user32 wrapper once (slow: ~10 s), prints READY,
# then answers each line read from stdin (a process id) with a JSON array of that process's
# top-level native windows. Exits when stdin closes, so it never outlives the Electron run.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class S3Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Get(uint pid) {
    var rows = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var cls = new StringBuilder(256); GetClassName(h, cls, 256);
      var title = new StringBuilder(256); GetWindowText(h, title, 256);
      bool owned = GetWindow(h, 4) != IntPtr.Zero; // GW_OWNER
      string c = cls.ToString().Replace("\\", "/").Replace("\"", "'");
      string t = title.ToString().Replace("\\", "/").Replace("\"", "'");
      rows.Add("{\"class\":\"" + c + "\",\"title\":\"" + t + "\",\"visible\":" + (IsWindowVisible(h) ? "true" : "false") + ",\"owned\":" + (owned ? "true" : "false") + "}");
      return true;
    }, IntPtr.Zero);
    return "[" + string.Join(",", rows) + "]";
  }
}
"@
[Console]::Out.WriteLine('READY')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  [Console]::Out.WriteLine([S3Win]::Get([uint32]$line.Trim()))
}
