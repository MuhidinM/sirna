# Shows Sirna's check toast and clicks one of its buttons through UI Automation,
# then prints the matching log lines. Run against the installed build.
# Usage: scripts/toast-check.ps1 [-Button "Got it"]
param([string]$Button = "Got it")

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$log = "$env:LOCALAPPDATA\dev.sirna.app\logs\Sirna.log"
$exe = "$env:LOCALAPPDATA\Sirna\sirna.exe"
$before = @(Get-Content $log -ErrorAction SilentlyContinue).Count

Start-Process $exe -ArgumentList '--test-toast'

# Toasts appear in a top-level window named "New notification" (Windows 10/11).
$popupName = New-Object System.Windows.Automation.PropertyCondition ($A::NameProperty), "New notification"
$buttonName = New-Object System.Windows.Automation.PropertyCondition ($A::NameProperty), $Button
$found = $null
$deadline = (Get-Date).AddSeconds(15)
while (-not $found -and (Get-Date) -lt $deadline) {
  $popups = $A::RootElement.FindAll($Scope::Children, $popupName)
  foreach ($popup in $popups) {
    $found = $popup.FindFirst($Scope::Descendants, $buttonName)
    if ($found) { break }
  }
  if (-not $found) { Start-Sleep -Milliseconds 200 }
}
if (-not $found) {
  "toast button '$Button' not found (is Do not disturb on?)"
  exit 1
}

$found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
Start-Sleep 2
@(Get-Content $log)[$before..100000] | Where-Object { $_ -match 'toast' }
