<#
.SYNOPSIS
  Start the PWA loopback server now, if it is not already up (no Scheduled Task, no elevation).

.DESCRIPTION
  Why this exists: deploy.ps1 owns the DURABLE pieces (the logon task and the tailscale serve handlers),
  and registering a task is a host-level change that needs the owner's word. This script only starts the
  process that serve-web.mjs needs behind `tailscale serve`:

    apps/mobile-companion/scripts/serve-web.mjs  on 127.0.0.1:<PwaPort>, hidden window, no console

  It is safe to run any number of times:
    - if something already LISTENS on PwaPort, it reports who and does nothing (never two servers);
    - it starts the process, then waits for it to answer `GET /` with 200 and prints its PID;
    - if the start fails, it says why and exits 1.

  What it does NOT do: no task, no registry, no firewall, no `tailscale serve`, no gateway, no profile,
  no secrets. The server is a child of whoever runs it, so a reboot or log-off ends it -- use
  `deploy.ps1 -Apply` (owner-gated: it registers the logon task) for the durable form.

  Windows-only, like deploy.ps1.

.PARAMETER PwaPort
  Loopback port serve-web.mjs listens on. Default 18480 (the port the serve mounts target).

.PARAMETER RepoRoot
  Checkout root (the directory holding apps/ and tools/). Default: two levels above this script.

.PARAMETER NodePath
  node executable. Default: the first `node` on PATH, resolved at run time.

.PARAMETER TimeoutSeconds
  How long to wait for the server to answer before declaring the start failed. Default 15.

.EXAMPLE
  .\tools\ops\pwa-up.ps1
#>
[CmdletBinding()]
param(
  [ValidateRange(1, 65535)][int]$PwaPort = 18480,
  [string]$RepoRoot = '',
  [string]$NodePath = '',
  [ValidateRange(1, 120)][int]$TimeoutSeconds = 15
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'pwa-up.ps1 targets Windows (serve-web.mjs is started with a hidden window).'
}

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}
$AppDir   = Join-Path $RepoRoot 'apps\mobile-companion'
$DistDir  = Join-Path $AppDir 'dist'
$ServeWeb = Join-Path $AppDir 'scripts\serve-web.mjs'

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if (!$found) { throw 'node was not found on PATH; pass -NodePath.' }
  $NodePath = $found.Source
}

# Same shape deploy.ps1 uses, and for the same reason: serve-web.mjs refuses to start on a dist that
# is not a built PWA, so say that here instead of letting the child die silently behind a hidden window.
$distOk = (Test-Path -LiteralPath (Join-Path $DistDir 'index.html')) -and (Test-Path -LiteralPath (Join-Path $DistDir 'sw.js'))
if (!$distOk) { throw "dist/ is missing or incomplete. Build it first:  cd apps\mobile-companion ; npm run build:web" }
if (!(Test-Path -LiteralPath $ServeWeb)) { throw "scripts/serve-web.mjs not found under $AppDir" }

Write-Host "pwa-up.ps1  repo=$RepoRoot  port=$PwaPort"

# 1. Never start a second server on the same port.
$existing = Get-NetTCPConnection -State Listen -LocalPort $PwaPort -ErrorAction SilentlyContinue
if ($existing) {
  $pid0 = ($existing | Select-Object -First 1 -ExpandProperty OwningProcess -ErrorAction Stop)
  Write-Host "   [ok]   port $PwaPort is already listening (pid $pid0); nothing started"
  exit 0
}

# 2. Start the loopback server exactly as deploy.ps1 registers it. Hidden window: a console window
# that closes would take the server with it.
$arguments = @($ServeWeb, '--port', "$PwaPort", '--host', '127.0.0.1', '--dir', $DistDir)
Write-Host "   [do]   start `"$NodePath`" $($arguments -join ' ')"
$proc = Start-Process -FilePath $NodePath -ArgumentList $arguments -WorkingDirectory $AppDir -WindowStyle Hidden -PassThru

# 3. Wait for a 200, not just for the process to exist: serve-web exits 2 on a failed listen, so a
#    process that is gone means the start failed and the exit code says why.
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
$url = "http://127.0.0.1:$PwaPort/"
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { throw "serve-web exited with code $($proc.ExitCode) (see its stderr; a port conflict or an unbuilt dist)." }
  try {
    $req = [System.Net.HttpWebRequest]::Create($url)
    $req.Method = 'GET'; $req.Timeout = 3000; $req.AllowAutoRedirect = $false
    $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close()
    if ($code -eq 200) {
      Write-Host "   [ok]   GET $url -> 200 (pid $($proc.Id))"
      Write-Host "   note   this server ends with its parent session; deploy.ps1 -Apply is the durable form."
      exit 0
    }
  }
  catch {
    Start-Sleep -Milliseconds 250
  }
}
throw "pid $($proc.Id) started but $url did not answer 200 within $TimeoutSeconds s."
