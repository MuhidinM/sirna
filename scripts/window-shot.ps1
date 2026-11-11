# Saves a PNG of a window by title, even when it is behind other windows
# (PrintWindow with PW_RENDERFULLCONTENT, which also draws WebView2 content).
# Usage: scripts/window-shot.ps1 -Title Sirna -Out today.png
param([string]$Title = "Sirna", [Parameter(Mandatory)][string]$Out)

Add-Type -AssemblyName System.Drawing
Add-Type -Name Win -Namespace WindowShot -MemberDefinition @"
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
public struct RECT { public int L, T, R, B; }
"@

$handle = [WindowShot.Win]::FindWindow([NullString]::Value, $Title)
if ($handle -eq [IntPtr]::Zero) { "no window titled '$Title'"; exit 1 }
# A minimised window has no size; show it without taking focus (SW_SHOWNOACTIVATE).
if ([WindowShot.Win]::IsIconic($handle)) { [WindowShot.Win]::ShowWindow($handle, 4) | Out-Null; Start-Sleep -Milliseconds 800 }
$rect = New-Object WindowShot.Win+RECT
[WindowShot.Win]::GetWindowRect($handle, [ref]$rect) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap ($rect.R - $rect.L), ($rect.B - $rect.T)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$dc = $graphics.GetHdc()
[WindowShot.Win]::PrintWindow($handle, $dc, 2) | Out-Null
$graphics.ReleaseHdc($dc)
$bitmap.Save($Out)
"saved $Out"
