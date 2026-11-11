# Private bytes of sirna.exe and every process it started (plan §10, Appendix B).
# Private bytes (commit) read higher than Task Manager's "private working set",
# so this is the stricter number.
# Usage: scripts/measure.ps1 [-Name sirna.exe]
param([string]$Name = "sirna.exe")

$all = Get-CimInstance Win32_Process
$ids = @(($all | Where-Object Name -eq $Name).ProcessId)
if ($ids.Count -eq 0) { "$Name is not running"; exit 1 }
do {
  $new = @($all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | ForEach-Object ProcessId)
  $ids += $new
} while ($new.Count)

$p = Get-Process -Id $ids -ErrorAction SilentlyContinue
$p | Select-Object Name, Id, @{ n = 'PrivMB'; e = { [math]::Round($_.PrivateMemorySize64 / 1MB, 1) } } | Format-Table -AutoSize | Out-String
'Total private MB: ' + [math]::Round(($p | Measure-Object PrivateMemorySize64 -Sum).Sum / 1MB, 1)
'WebView2 processes: ' + @($p | Where-Object ProcessName -eq 'msedgewebview2').Count
'CPU seconds (sirna.exe): ' + [math]::Round((Get-Process -Id $ids[0]).TotalProcessorTime.TotalSeconds, 2)
