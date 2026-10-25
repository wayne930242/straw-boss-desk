<#
.SYNOPSIS
  Starts a program on the interactive desktop of the signed-in user, from an SSH session (which has no desktop).
.DESCRIPTION
  Registers a one-shot scheduled task for the current user with an interactive logon type (the same effect as `schtasks /create /it`,
  without schtasks' 261-character /tr limit), starts it, optionally waits for it to end, and removes the task.
.EXAMPLE
  ui-run.ps1 -Exe powershell.exe -Arguments '-NoExit -NoProfile -ExecutionPolicy Bypass -File C:\Users\x\sbd-kit\check-claude.ps1'
#>
param(
    [Parameter(Mandatory = $true)][string]$Exe,
    [string]$Arguments = '',
    [string]$WorkingDirectory = $env:USERPROFILE,
    [string]$Name = 'sbd-ui',
    [switch]$Wait,
    [int]$TimeoutSec = 600
)
$ErrorActionPreference = 'Stop'
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute $Exe -Argument $Arguments -WorkingDirectory $WorkingDirectory
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $Name -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $Name
Write-Host "started task $Name as $user"
if ($Wait) {
    $end = (Get-Date).AddSeconds($TimeoutSec)
    Start-Sleep -Seconds 2
    while ((Get-Date) -lt $end -and (Get-ScheduledTask -TaskName $Name).State -eq 'Running') { Start-Sleep -Seconds 2 }
    $info = Get-ScheduledTaskInfo -TaskName $Name
    Write-Host "task result: $($info.LastTaskResult) state: $((Get-ScheduledTask -TaskName $Name).State)"
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue
}
