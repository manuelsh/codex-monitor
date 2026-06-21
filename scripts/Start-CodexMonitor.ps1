param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"

function Repair-ProcessPathEnvironment {
  $variables = [Environment]::GetEnvironmentVariables("Process")
  $pathKeys = @(
    $variables.Keys |
      ForEach-Object { [string]$_ } |
      Where-Object { $_ -ieq "PATH" }
  )

  if ($pathKeys.Count -le 1) {
    return
  }

  $pathValue = $env:Path
  if (-not $pathValue) {
    $pathValue = [string]$variables[$pathKeys[0]]
  }

  foreach ($pathKey in $pathKeys) {
    [Environment]::SetEnvironmentVariable($pathKey, $null, "Process")
  }

  [Environment]::SetEnvironmentVariable("Path", $pathValue, "Process")
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$port = 4201
if ($env:PORT) {
  $port = [int]$env:PORT
}

Repair-ProcessPathEnvironment

$serverEntry = Join-Path $repoRoot "dist\server\index.js"
if (-not (Test-Path $serverEntry)) {
  Push-Location $repoRoot
  try {
    npm run build
  } finally {
    Pop-Location
  }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1

$shouldStart = -not $listener
if ($listener) {
  try {
    $snapshot = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/snapshot" -TimeoutSec 3
    if ($snapshot.activeShutdown.dryRun -eq $true) {
      Stop-Process -Id $listener.OwningProcess -Force
      Start-Sleep -Seconds 1
      $shouldStart = $true
    }
  } catch {
    Write-Host "Port $port is already in use, but Codex Monitor did not respond."
  }
}

if ($shouldStart) {
  $outLog = Join-Path $repoRoot "codex-monitor.out.log"
  $errLog = Join-Path $repoRoot "codex-monitor.err.log"

  $env:NODE_ENV = "production"
  $env:CODEX_MONITOR_DRY_RUN = "0"
  $env:PORT = [string]$port

  Start-Process `
    -FilePath "node" `
    -ArgumentList @("dist/server/index.js") `
    -WorkingDirectory $repoRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog | Out-Null

  Start-Sleep -Seconds 2
}

if (-not $NoBrowser) {
  Start-Process "http://127.0.0.1:$port"
}
