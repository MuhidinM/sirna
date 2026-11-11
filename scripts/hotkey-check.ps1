# Presses the capture hotkey and measures "hotkey to ready to type" (plan §10).
# Needs Sirna started with stderr sent to -Log, e.g.
#   Start-Process sirna.exe -ArgumentList '--autostart' -RedirectStandardError $env:TEMP\sirna-err.txt
# Usage: scripts/hotkey-check.ps1 [-Key Space|J] [-Text "lunch 120"] [-Tries 20] [-Log path]
param(
  [string]$Key = "Space",
  [string]$Text = "",
  [int]$Tries = 1,
  [string]$Log = "$env:TEMP\sirna-err.txt"
)

Add-Type -Name K -Namespace SirnaCheck -MemberDefinition @"
[DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
"@
Add-Type -AssemblyName System.Windows.Forms

$vk = if ($Key -eq "Space") { 0x20 } else { [byte][char]$Key.ToUpper() }

function Press-Hotkey {
  $up = 2
  [SirnaCheck.K]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)   # Ctrl
  [SirnaCheck.K]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)   # Alt
  [SirnaCheck.K]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  [SirnaCheck.K]::keybd_event($vk, 0, $up, [UIntPtr]::Zero)
  [SirnaCheck.K]::keybd_event(0x12, 0, $up, [UIntPtr]::Zero)
  [SirnaCheck.K]::keybd_event(0x11, 0, $up, [UIntPtr]::Zero)
}

function Ready-Lines { @(Get-Content $Log -ErrorAction SilentlyContinue | Where-Object { $_ -match '^capture ready in (\d+) ms' }) }

$times = @()
for ($i = 0; $i -lt $Tries; $i++) {
  $before = (Ready-Lines).Count
  Press-Hotkey
  $deadline = (Get-Date).AddSeconds(5)
  while ((Ready-Lines).Count -le $before -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 20 }
  $lines = Ready-Lines
  if ($lines.Count -le $before) { "try $($i + 1): capture box never became ready"; continue }
  $times += [int][regex]::Match([string]$lines[-1], '(\d+) ms').Groups[1].Value
  if ($Text) { [System.Windows.Forms.SendKeys]::SendWait($Text + "{ENTER}"); Start-Sleep -Milliseconds 2500 }
  else { [System.Windows.Forms.SendKeys]::SendWait("{ESC}"); Start-Sleep -Milliseconds 800 }
}
if ($times.Count) {
  $sorted = $times | Sort-Object
  $p95 = $sorted[[math]::Min($sorted.Count - 1, [math]::Ceiling($sorted.Count * 0.95) - 1)]
  "ready to type after (ms): " + ($times -join ", ") + " | p95 = $p95"
}
