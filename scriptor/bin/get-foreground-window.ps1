# get-foreground-window.ps1
# Returns: "window title|process name" for the currently focused window

Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@

try {
  $hWnd = [FgWin]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 1024
  [FgWin]::GetWindowText($hWnd, $sb, 1024) | Out-Null
  $title = $sb.ToString()

  $procId = 0u
  [FgWin]::GetWindowThreadProcessId($hWnd, [ref]$procId) | Out-Null
  $proc = Get-Process -Id ([int]$procId) -ErrorAction SilentlyContinue
  $procName = if ($proc) { $proc.Name + ".exe" } else { "" }

  Write-Output "$title|$procName"
} catch {
  Write-Output "|"
}
