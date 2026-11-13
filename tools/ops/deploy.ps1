<#
.SYNOPSIS
  Durable deployment of the DSH mobile PWA + gateway behind `tailscale serve` (roadmap P0-3).

.DESCRIPTION
  Owns exactly two pieces of host state, and nothing else:

    1. a per-user Scheduled Task ("DSH PWA server") that runs apps/mobile-companion/scripts/serve-web.mjs
       on 127.0.0.1:<PwaPort> at logon, restarting on failure;
    2. the `tailscale serve` handlers on ONE tailnet HTTPS port (<HttpsPort>):
         /           -> http://127.0.0.1:<PwaPort>
         /ws/mobile  -> https+insecure://127.0.0.1:<GatewayPort>/ws/mobile

  It never touches another serve port, never runs `tailscale serve reset`, never edits a profile,
  never changes the gateway's configuration, and never needs elevation (the task is per-user).

  DRY-RUN IS THE DEFAULT. Without -Apply or -Remove it only reads state and prints what it WOULD do.
    -Apply   perform the actions (idempotent: re-running converges, it does not stack).
    -Remove  undo exactly what -Apply did: delete the task, and drop the HttpsPort handlers, but only
             when they are still the ones this script installed (anything else is left alone and
             reported).

  Nothing in this file is a host name, address or account: the tailnet name is a parameter and is
  only ever printed, never stored.

.PARAMETER TailnetHost
  Your machine's tailnet DNS name (<machine>.<tailnet>.ts.net). Required for the verification step;
  find it with `tailscale status --json` (Self.DNSName). Passed in, never written to a file.

.PARAMETER HttpsPort
  The tailnet HTTPS port to claim. Default 30443. Only this port is ever modified.

.PARAMETER PwaPort
  The loopback port serve-web.mjs listens on. Default 18480.

.PARAMETER GatewayPort
  The loopback port the gateway's TLS listener binds. Default 30081.

.PARAMETER RepoRoot
  Checkout root (the directory holding apps/ and tools/). Default: two levels above this script.

.PARAMETER Apply
  Make the changes. Without it, nothing is modified.

.PARAMETER Remove
  Undo this script's own changes. Mutually exclusive with -Apply.

.PARAMETER NodePath
  node executable for the task. Default: the first `node` on PATH, resolved at run time.

.EXAMPLE
  # Preview (changes nothing):
  .\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net

  # Install:
  .\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net -Apply

  # Undo:
  .\tools\ops\deploy.ps1 -TailnetHost <machine>.<tailnet>.ts.net -Remove
#>
[CmdletBinding()]
param(
  [string]$TailnetHost = '',
  [ValidateRange(1, 65535)][int]$HttpsPort = 30443,
  [ValidateRange(1, 65535)][int]$PwaPort = 18480,
  [ValidateRange(1, 65535)][int]$GatewayPort = 30081,
  [string]$RepoRoot = '',
  [string]$NodePath = '',
  [switch]$Apply,
  [switch]$Remove
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# Constants: the only names this script owns. -Remove looks for exactly these.
# ---------------------------------------------------------------------------------------------
$TaskName    = 'DSH PWA server'
$ProxyRoot   = "http://127.0.0.1:$PwaPort"
$ProxyWs     = "https+insecure://127.0.0.1:$GatewayPort/ws/mobile"
$ServeRoots  = '/'
$ServeWs     = '/ws/mobile'

$script:Problems = New-Object System.Collections.Generic.List[string]
$script:Mode = if ($Apply) { 'APPLY' } elseif ($Remove) { 'REMOVE' } else { 'DRY-RUN' }

function Say([string]$Text)  { Write-Host $Text }
function Head([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Info([string]$Text) { Write-Host "   $Text" }
function Good([string]$Text) { Write-Host "   [ok]   $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "   [warn] $Text" -ForegroundColor Yellow }
function Bad([string]$Text)  { Write-Host "   [FAIL] $Text" -ForegroundColor Red; $script:Problems.Add($Text) | Out-Null }
# A line that would change state: printed in every mode, executed only by -Apply/-Remove.
function Would([string]$Text) {
  if ($script:Mode -eq 'DRY-RUN') { Write-Host "   [would] $Text" -ForegroundColor Magenta }
  else { Write-Host "   [do]    $Text" -ForegroundColor Magenta }
}

if ($Apply -and $Remove) { throw 'Choose one of -Apply or -Remove, not both.' }

# ---------------------------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}
$AppDir    = Join-Path $RepoRoot 'apps\mobile-companion'
$DistDir   = Join-Path $AppDir 'dist'
$ServeWeb  = Join-Path $AppDir 'scripts\serve-web.mjs'

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { $NodePath = $found.Source }
}

# Windows PowerShell 5.1 has no `$IsWindows`; this script is Windows-only by design.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'deploy.ps1 targets Windows (Scheduled Tasks + tailscale.exe).'
}

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root) {
      $candidate = Join-Path $root 'Tailscale\tailscale.exe'
      if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
  }
  return $null
}
$Tailscale = Find-Tailscale

Say "deploy.ps1  mode=$($script:Mode)"
Say "  repo       : $RepoRoot"
Say "  https port : $HttpsPort (tailnet)   pwa port: $PwaPort (loopback)   gateway port: $GatewayPort (loopback)"
if ($TailnetHost) { Say "  tailnet    : $TailnetHost" } else { Say '  tailnet    : (not given: URL verification will be skipped)' }
if ($script:Mode -eq 'DRY-RUN') { Say '  NOTHING WILL BE CHANGED. Add -Apply to install or -Remove to undo.' }

# ---------------------------------------------------------------------------------------------
# tailscale serve helpers. Every call is scoped by --https=<HttpsPort>; there is deliberately no
# call that takes no port, and no `reset`, so no other serve entry can be reached from here.
# ---------------------------------------------------------------------------------------------

# Run tailscale and return @{ Code; Text }. stderr is folded in: the CLI prints some results there.
function Invoke-Tailscale([string[]]$Arguments) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # 5.1 turns native stderr into ErrorRecords otherwise
  try {
    $text = & $Tailscale @Arguments 2>&1 | ForEach-Object { "$_" } | Out-String
    return @{ Code = $LASTEXITCODE; Text = $text.TrimEnd() }
  }
  finally { $ErrorActionPreference = $old }
}

# The Web-key for this node on HttpsPort, as the CLI keys it: "<dns-name>:<port>".
# Returns the handlers table for that port (a PSCustomObject), or $null when the port is unused.
function Get-PortHandlers {
  $r = Invoke-Tailscale @('serve', 'status', '--json')
  if ($r.Code -ne 0) { throw "tailscale serve status failed (exit $($r.Code)): $($r.Text)" }
  if ([string]::IsNullOrWhiteSpace($r.Text) -or $r.Text -eq '{}') { return $null }
  $json = $r.Text | ConvertFrom-Json
  if (-not ($json.PSObject.Properties.Name -contains 'Web')) { return $null }
  foreach ($prop in $json.Web.PSObject.Properties) {
    if ($prop.Name -match ":$HttpsPort$") { return $prop.Value.Handlers }
  }
  return $null
}

# Flatten a Handlers object into a { path -> proxy } hashtable.
function ConvertTo-HandlerMap($Handlers) {
  $map = @{}
  if ($null -ne $Handlers) {
    foreach ($h in $Handlers.PSObject.Properties) {
      $proxy = ''
      if ($h.Value.PSObject.Properties.Name -contains 'Proxy') { $proxy = [string]$h.Value.Proxy }
      $map[$h.Name] = $proxy
    }
  }
  return $map
}

function Test-OwnHandlers([hashtable]$Map) {
  return ($Map.Count -eq 2 -and $Map[$ServeRoots] -eq $ProxyRoot -and $Map[$ServeWs] -eq $ProxyWs)
}

# ---------------------------------------------------------------------------------------------
# 1. PWA build
# ---------------------------------------------------------------------------------------------
Head '1. PWA build (apps/mobile-companion/dist)'
$distOk = (Test-Path -LiteralPath (Join-Path $DistDir 'index.html')) -and (Test-Path -LiteralPath (Join-Path $DistDir 'sw.js'))
if ($distOk) { Good 'dist/index.html and dist/sw.js are present' }
elseif ($script:Mode -eq 'REMOVE') { Info 'dist is not present (not needed for -Remove)' }
else {
  Bad 'dist/ is missing or incomplete. Build it first:  cd apps\mobile-companion ; npm run build:web'
}
if (Test-Path -LiteralPath $ServeWeb) { Good 'scripts/serve-web.mjs is present' }
elseif ($script:Mode -ne 'REMOVE') { Bad "scripts/serve-web.mjs not found under $AppDir" }

# ---------------------------------------------------------------------------------------------
# 2. Scheduled Task
# ---------------------------------------------------------------------------------------------
Head "2. Scheduled Task '$TaskName' (per-user, at logon)"
if (-not $NodePath -and $script:Mode -ne 'REMOVE') { Bad 'node was not found on PATH; pass -NodePath' }

$existing = $null
try { $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { $existing = $null }

if ($script:Mode -eq 'REMOVE') {
  if ($existing) {
    Would "Stop-ScheduledTask / Unregister-ScheduledTask '$TaskName'"
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Good "removed task '$TaskName'"
  }
  else { Info "no task named '$TaskName' (nothing to remove)" }
}
else {
  $arguments = '"{0}" --port {1} --host 127.0.0.1 --dir "{2}"' -f $ServeWeb, $PwaPort, $DistDir
  if ($existing) {
    $currentExec = $existing.Actions | Select-Object -First 1
    if ($currentExec -and $currentExec.Arguments -eq $arguments -and $currentExec.Execute -eq $NodePath) {
      Good "task already registered with the same command (will be left as is)"
    }
    else { Would "re-register '$TaskName' (its command differs from the one below)" }
  }
  else { Would "register '$TaskName'" }
  Info "run        : `"$NodePath`" $arguments"
  Info 'trigger    : at logon of the current user'
  Info 'restart    : on failure, every 1 minute, up to 3 times; no time limit; start when available'
  Info 'principal  : the current user, limited (no elevation, no password stored)'

  if ($script:Mode -eq 'APPLY' -and $distOk -and $NodePath -and (Test-Path -LiteralPath $ServeWeb)) {
    $action    = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $AppDir
    $trigger   = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
    $settings  = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
                   -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -StartWhenAvailable `
                   -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
                   -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
      -Principal $principal -Description 'DSH mobile PWA static server (loopback). Managed by tools/ops/deploy.ps1.' -Force | Out-Null
    Good "registered task '$TaskName'"
    # Start it now unless something already answers on the port (do not fight a manual instance).
    $listening = Get-NetTCPConnection -State Listen -LocalPort $PwaPort -ErrorAction SilentlyContinue
    if ($listening) { Info "port $PwaPort is already listening; not starting a second instance" }
    else {
      Start-ScheduledTask -TaskName $TaskName
      Good "started '$TaskName'"
    }
  }
}

# ---------------------------------------------------------------------------------------------
# 3. tailscale serve on HttpsPort only
# ---------------------------------------------------------------------------------------------
Head "3. tailscale serve on https port $HttpsPort (no other port is touched)"
if (-not $Tailscale) {
  Bad 'tailscale.exe not found (install Tailscale and sign in)'
}
else {
  $current = ConvertTo-HandlerMap (Get-PortHandlers)
  $owned = Test-OwnHandlers $current

  if ($script:Mode -eq 'REMOVE') {
    if ($current.Count -eq 0) { Info "port $HttpsPort has no serve handlers (nothing to remove)" }
    elseif ($owned) {
      Would "tailscale serve --https=$HttpsPort off"
      $r = Invoke-Tailscale @('serve', "--https=$HttpsPort", 'off')
      if ($r.Code -eq 0) { Good "removed the handlers on port $HttpsPort" } else { Bad "tailscale serve off failed (exit $($r.Code)): $($r.Text)" }
    }
    else {
      Warn "port $HttpsPort holds handlers this script did not install; leaving them alone:"
      foreach ($key in ($current.Keys | Sort-Object)) { Info ("  {0,-12} -> {1}" -f $key, $current[$key]) }
    }
  }
  else {
    if ($owned) { Good "port $HttpsPort already serves exactly the two expected handlers" }
    elseif ($current.Count -gt 0) {
      # Something else lives on this port. Replacing it would not be "only its own changes".
      $foreign = @($current.Keys | Where-Object { $_ -ne $ServeRoots -and $_ -ne $ServeWs })
      if ($foreign.Count -gt 0) {
        Bad "port $HttpsPort has handlers this script does not own ($($foreign -join ', ')). Pick another -HttpsPort."
      }
      else { Info "port $HttpsPort has a partial or different mapping; the commands below will converge it" }
    }
    if (-not $owned) {
      Would "tailscale serve --bg --https=$HttpsPort $ProxyRoot"
      Would "tailscale serve --bg --https=$HttpsPort --set-path $ServeWs $ProxyWs"
    }
    else { Info 'nothing to change on this port' }
    if ($script:Mode -eq 'APPLY' -and -not $owned -and $script:Problems.Count -eq 0) {
      $r1 = Invoke-Tailscale @('serve', '--bg', "--https=$HttpsPort", $ProxyRoot)
      if ($r1.Code -ne 0) { Bad "serve '/' failed (exit $($r1.Code)): $($r1.Text)" }
      else {
        $r2 = Invoke-Tailscale @('serve', '--bg', "--https=$HttpsPort", '--set-path', $ServeWs, $ProxyWs)
        if ($r2.Code -ne 0) { Bad "serve '$ServeWs' failed (exit $($r2.Code)): $($r2.Text)" }
        else { Good "port $HttpsPort now serves '/' and '$ServeWs'" }
      }
    }
    elseif ($script:Mode -eq 'APPLY' -and $script:Problems.Count -gt 0) {
      Warn 'not touching tailscale serve: an earlier step failed'
    }
  }
}

# ---------------------------------------------------------------------------------------------
# 4. Gateway listen target: instructions only (this script does not edit the gateway's config)
# ---------------------------------------------------------------------------------------------
if ($script:Mode -ne 'REMOVE') {
  Head '4. Gateway listen target (do this yourself; this script does not change the gateway)'
  Info "The gateway's TLS listener MUST bind loopback, port $GatewayPort, behind tailscale serve."
  Info 'In the Devices page set the listen target to "Loopback" (or lanHost = 127.0.0.1 in the plugin config).'
  Info 'Do NOT bind it to the tailnet address: Windows drops a self-dial to the machine''s own tailnet'
  Info 'IP that comes from a physical NIC source, so tailscale serve could not reach it (see docs/ops/runbook.md).'
  Info ("Confirm with:   Get-NetTCPConnection -State Listen -LocalPort {0}   (LocalAddress must be 127.0.0.1)" -f $GatewayPort)
  $gw = Get-NetTCPConnection -State Listen -LocalPort $GatewayPort -ErrorAction SilentlyContinue
  if ($gw) {
    $addresses = @($gw | Select-Object -ExpandProperty LocalAddress -Unique)
    $nonLoopback = @($addresses | Where-Object { $_ -ne '127.0.0.1' -and $_ -ne '::1' })
    if ($nonLoopback.Count -gt 0) { Bad "port $GatewayPort listens on $($nonLoopback -join ', '): it must be 127.0.0.1 only" }
    else { Good "port $GatewayPort listens on loopback only" }
  }
  else { Warn "nothing is listening on $GatewayPort yet (the gateway is not running or not enabled)" }
}

# ---------------------------------------------------------------------------------------------
# 5. Verification (read-only requests; no credential is ever sent)
# ---------------------------------------------------------------------------------------------
if ($script:Mode -ne 'REMOVE') {
  Head "5. Verification via https://<tailnet>:$HttpsPort"
  if (-not $TailnetHost) { Warn 'skipped: pass -TailnetHost <machine>.<tailnet>.ts.net' }
  elseif ($script:Mode -eq 'DRY-RUN') {
    Info "would check:  GET /                         expect 200"
    Info "would check:  WS $ServeWs  (no credential)   expect 401"
    Info "would check:  WS $ServeWs  (Origin: https://evil.invalid)  expect 403"
    Info "would check:  GET /mgw/status               expect NOT 200"
    Info 'skipped in dry-run because nothing has been applied yet.'
  }
  else {
    $base = "https://${TailnetHost}:$HttpsPort"

    # Sentinels: the probe reports WHY it got no status, so the message can name the real fault.
    # Certificate validation is never bypassed: the tailnet certificate is CA-issued and must chain.
    $NO_ANSWER = -1    # nothing accepted the TCP connection (or the proxy hop failed)
    $TLS_FAIL  = -2    # connected, but the TLS handshake failed (untrusted/absent certificate)

    # --- HTTP GET helper (5.1: HttpWebRequest, so a non-2xx status is a value, not an exception)
    function Get-HttpStatus([string]$Url) {
      try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = 'GET'; $req.Timeout = 10000; $req.AllowAutoRedirect = $false
        $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close(); return $code
      }
      catch [System.Net.WebException] {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        $status = $_.Exception.Status
        if ($status -eq [System.Net.WebExceptionStatus]::TrustFailure -or
            $status -eq [System.Net.WebExceptionStatus]::SecureChannelFailure) { return $TLS_FAIL }
        return $NO_ANSWER
      }
    }

    # --- WS upgrade probe over TLS: send a raw upgrade request and read only the status line.
    function Get-UpgradeStatus([string]$HostName, [int]$Port, [string]$Path, [string]$Origin) {
      $client = $null; $ssl = $null
      try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.ReceiveTimeout = 10000; $client.SendTimeout = 10000
        $client.Connect($HostName, $Port)
        $ssl = New-Object System.Net.Security.SslStream($client.GetStream(), $false)
        $ssl.AuthenticateAsClient($HostName)
        $key = [Convert]::ToBase64String([byte[]](1..16))
        $lines = @("GET $Path HTTP/1.1", "Host: ${HostName}:$Port", 'Upgrade: websocket', 'Connection: Upgrade',
                   "Sec-WebSocket-Key: $key", 'Sec-WebSocket-Version: 13')
        if ($Origin) { $lines += "Origin: $Origin" }
        $bytes = [Text.Encoding]::ASCII.GetBytes(($lines -join "`r`n") + "`r`n`r`n")
        $ssl.Write($bytes, 0, $bytes.Length); $ssl.Flush()
        $buf = New-Object byte[] 256
        $n = $ssl.Read($buf, 0, $buf.Length)
        if ($n -le 0) { return $NO_ANSWER }
        $first = ([Text.Encoding]::ASCII.GetString($buf, 0, $n) -split "`r`n")[0]
        if ($first -match '^HTTP/\d\.\d (\d{3})') { return [int]$Matches[1] }
        return $NO_ANSWER
      }
      catch [System.Security.Authentication.AuthenticationException] { return $TLS_FAIL }
      catch { return $NO_ANSWER }
      finally { if ($ssl) { $ssl.Dispose() }; if ($client) { $client.Close() } }
    }

    # One sentence for a sentinel, naming what to look at.
    function Describe-NoStatus([int]$Status) {
      if ($Status -eq $TLS_FAIL) { return 'TLS handshake failed: the tailnet certificate did not validate (is HTTPS enabled for this tailnet?)' }
      return "no answer: tailscale serve could not reach the gateway on 127.0.0.1:$GatewayPort"
    }

    $s = Get-HttpStatus "$base/"
    if ($s -eq 200) { Good "GET /  -> 200" }
    elseif ($s -lt 0) { Bad ("GET /  -> " + (Describe-NoStatus $s) + ' (the PWA server task is probably not running)') }
    else { Bad "GET /  -> $s (expected 200)" }

    $s = Get-UpgradeStatus $TailnetHost $HttpsPort $ServeWs ''
    # The gateway checks remote-control-enabled (403 'remote/disabled') BEFORE the credential, so a
    # 403 here means the owner switch is off, not that the fence is broken.
    if ($s -eq 401) { Good "WS $ServeWs without a credential -> 401" }
    elseif ($s -eq 403) { Bad "WS $ServeWs without a credential -> 403: remote control is OFF in the gateway (turn it on in the Devices page)" }
    elseif ($s -lt 0) { Bad ("WS $ServeWs without a credential -> " + (Describe-NoStatus $s)) }
    else { Bad "WS $ServeWs without a credential -> $s (expected 401)" }

    $s = Get-UpgradeStatus $TailnetHost $HttpsPort $ServeWs 'https://evil.invalid'
    # The Origin fence runs BEFORE `gatewayEnabled`, so this must be 403 even with remote control
    # off; a 401 would mean the request got past the fence to the credential check.
    if ($s -eq 403) { Good "WS $ServeWs with a foreign Origin -> 403" }
    elseif ($s -lt 0) { Bad ("WS $ServeWs with a foreign Origin -> " + (Describe-NoStatus $s)) }
    else { Bad "WS $ServeWs with a foreign Origin -> $s (expected 403)" }

    # The management surface must be unreachable through the proxy: anything but 200 is acceptable
    # (the serve table has no /mgw handler, so the PWA server answers 404), 200 is a leak.
    $s = Get-HttpStatus "$base/mgw/status"
    if ($s -eq 200) { Bad "GET /mgw/status -> 200: the management API is reachable through the proxy" }
    elseif ($s -lt 0) { Bad ("GET /mgw/status -> " + (Describe-NoStatus $s) + ': cannot prove the surface is unreachable') }
    else { Good "GET /mgw/status -> $s (not 200)" }
  }
}

# ---------------------------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------------------------
Head "Result ($($script:Mode))"
if ($script:Problems.Count -gt 0) {
  foreach ($p in $script:Problems) { Say "  - $p" }
  Say ''
  Say "$($script:Problems.Count) problem(s)."
  exit 1
}
if ($script:Mode -eq 'DRY-RUN') { Say '  Dry-run complete: nothing was changed.' }
else { Say "  $($script:Mode) complete." }
exit 0
