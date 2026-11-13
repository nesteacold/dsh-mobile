# Run sync-presets.cjs with DSH's own Electron (reads app.asar). Used by the logon task
# "DSH dsh-roles preset sync" and safe to run by hand. Log: %LOCALAPPDATA%\dsh-roles-sync.log
param([switch]$Check)
$ErrorActionPreference = 'Stop'
trap { "$(Get-Date -Format s) error: $_" | Add-Content (Join-Path $env:LOCALAPPDATA 'dsh-roles-sync.log'); exit 2 }
$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$script = Join-Path $PSScriptRoot 'sync-presets.cjs'
$log = Join-Path $env:LOCALAPPDATA 'dsh-roles-sync.log'
if (-not (Test-Path $exe)) { "$(Get-Date -Format s) DSH exe not found: $exe" | Add-Content $log; exit 2 }
# Direct CreateProcess (no ShellExecute): under Task Scheduler, Start-Process on this exe
# asks for elevation (measured 2026-11-13), which a hidden logon task cannot satisfy.
$si = New-Object System.Diagnostics.ProcessStartInfo $exe
$si.Arguments = "`"$script`"" + $(if ($Check) { ' --check' } else { '' })
$si.UseShellExecute = $false; $si.CreateNoWindow = $true
$si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true
$si.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$p = [System.Diagnostics.Process]::Start($si)
$errTask = $p.StandardError.ReadToEndAsync(); $stdout = $p.StandardOutput.ReadToEnd(); $p.WaitForExit()
$errLines = $errTask.Result -split "`n" | Where-Object { $_ -match 'sync-presets' }
$msg = ((@($stdout.Trim()) + $errLines) | Where-Object { $_ }) -join ' | '
"$(Get-Date -Format s) exit=$($p.ExitCode) $msg" | Add-Content $log
Write-Output $msg
exit $p.ExitCode
