@echo off
setlocal
cd /d "%~dp0"
set "YEOMAI_BAT_SELF=%~f0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$raw=Get-Content -LiteralPath $env:YEOMAI_BAT_SELF -Raw; $marker='#PS_BEGIN#'; Invoke-Expression $raw.Substring($raw.LastIndexOf($marker)+$marker.Length)"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  pause
) else (
  ping -n 4 127.0.0.1 >nul
)

exit /b %EXIT_CODE%

#PS_BEGIN#
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $env:YEOMAI_BAT_SELF
$runDir = Join-Path $root "data\local\run"
$logDir = Join-Path $root "data\local\logs"
$parentPidFile = Join-Path $runDir "start-local-root.pid"
$ports = @(3000, 4000, 41337, 41339, 41340)
$pidFiles = @(
  "start-local-root.pid",
  "gateway.pid",
  "web.pid",
  "api.pid",
  "worker.pid",
  "lore.pid",
  "lore-supervisor.pid"
)

New-Item -ItemType Directory -Force -Path $runDir, $logDir | Out-Null

function Test-LocalEndpoint([string]$url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Get-OccupiedPorts {
  $tcp = Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue
  $udp = Get-NetUDPEndpoint -LocalPort $ports -ErrorAction SilentlyContinue
  return @($tcp) + @($udp) |
    Where-Object { $_ } |
    Sort-Object LocalPort |
    Select-Object LocalAddress, LocalPort, OwningProcess
}

function Get-ProjectProcessIds {
  $rootLower = $root.ToLowerInvariant()
  $patterns = @(
    "scripts[\\/]+start-local\.sh",
    "scripts[\\/]+public-gateway\.mjs",
    "apps[\\/]+server.*src[\\/]+index\.ts",
    "next.*--port\s+41340",
    "loreserver(\.exe)?.*data[\\/]+local[\\/]+config"
  )

  $ids = New-Object System.Collections.Generic.HashSet[int]
  Get-CimInstance Win32_Process | ForEach-Object {
    $commandLine = [string]$_.CommandLine
    $normalized = $commandLine.ToLowerInvariant().Replace("/", "\")
    if (-not $normalized.Contains($rootLower)) {
      return
    }
    foreach ($pattern in $patterns) {
      if ($commandLine -match $pattern) {
        [void]$ids.Add([int]$_.ProcessId)
        break
      }
    }
  }

  foreach ($pidFile in $pidFiles) {
    $path = Join-Path $runDir $pidFile
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $rawPid = Get-Content -LiteralPath $path -ErrorAction SilentlyContinue |
      Select-Object -First 1
    $parsedPid = 0
    if (-not [int]::TryParse([string]$rawPid, [ref]$parsedPid)) {
      continue
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$parsedPid" -ErrorAction SilentlyContinue
    if (-not $process) {
      continue
    }
    $commandLine = [string]$process.CommandLine
    $normalized = $commandLine.ToLowerInvariant().Replace("/", "\")
    $allowedHost = $process.Name -in @("node.exe", "bash.exe", "sh.exe", "loreserver.exe")
    $belongsToProject =
      $normalized.Contains($rootLower) -or
      ($pidFile -eq "api.pid" -and $commandLine -match "src[\\/]+index\.ts")
    if ($allowedHost -and $belongsToProject) {
      [void]$ids.Add($parsedPid)
    }
  }

  return @($ids)
}

function Wait-ForProjectStopped([int]$timeoutSeconds = 25) {
  $deadline = (Get-Date).AddSeconds($timeoutSeconds)
  do {
    $remainingProcesses = Get-ProjectProcessIds
    $occupied = Get-OccupiedPorts
    if ($remainingProcesses.Count -eq 0 -and $occupied.Count -eq 0) {
      return $true
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Convert-ToGitBashPath([string]$path) {
  $fullPath = [System.IO.Path]::GetFullPath($path)
  if ($fullPath -notmatch "^([A-Za-z]):\\(.*)$") {
    throw "Only local drive paths are supported: $fullPath"
  }
  $drive = $matches[1].ToLowerInvariant()
  $rest = $matches[2].Replace("\", "/")
  return "/$drive/$rest"
}

function Show-LogTail([string]$name) {
  $path = Join-Path $logDir "$name.log"
  if (Test-Path -LiteralPath $path) {
    Write-Host ""
    Write-Host "Last lines from $name.log:" -ForegroundColor Yellow
    Get-Content -LiteralPath $path -Tail 30
  }
}

Write-Host "Checking existing processes and ports..."
$runtimeHealthy =
  (Test-LocalEndpoint "http://localhost:3000/health_check") -and
  (Test-LocalEndpoint "http://localhost:4000/health_check") -and
  (Test-LocalEndpoint "http://localhost:41339/health_check")

if ($runtimeHealthy) {
  Write-Host "Yeomai Lore is already running: http://localhost:3000" -ForegroundColor Green
  exit 0
}

$existingProjectProcesses = Get-ProjectProcessIds
if ($existingProjectProcesses.Count -gt 0) {
  Write-Host "Found existing or partially stopped project processes. Cleaning them up..."
  & (Join-Path $root "stop.bat") *> $null
  if ($LASTEXITCODE -ne 0 -or -not (Wait-ForProjectStopped)) {
    Write-Host "Existing project processes did not stop cleanly." -ForegroundColor Red
    exit 1
  }
}

$occupied = Get-OccupiedPorts
if ($occupied.Count -gt 0) {
  Write-Host "Cannot start: required ports are occupied by another application." -ForegroundColor Red
  $occupied | Format-Table -AutoSize
  Write-Host "Stop the process shown above before starting Yeomai Lore."
  exit 1
}

$bashCandidates = @(
  (Join-Path $env:ProgramFiles "Git\bin\bash.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Git\bin\bash.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

$bash = $bashCandidates | Select-Object -First 1
if (-not $bash) {
  Write-Host "Git Bash was not found. Install Git for Windows first." -ForegroundColor Red
  exit 1
}

$unixRoot = Convert-ToGitBashPath $root
$bashCommand = "cd '$unixRoot' && exec sh scripts/start-local.sh"
$bashArguments = "-lc `"$bashCommand`""
$startOut = Join-Path $logDir "start-local.out.log"
$startErr = Join-Path $logDir "start-local.err.log"

$process = Start-Process `
  -FilePath $bash `
  -ArgumentList $bashArguments `
  -WorkingDirectory $root `
  -WindowStyle Hidden `
  -RedirectStandardOutput $startOut `
  -RedirectStandardError $startErr `
  -PassThru

Set-Content -LiteralPath $parentPidFile -Value $process.Id -Encoding ascii
Write-Host "Starting Yeomai Lore..."

$started = $false
for ($attempt = 0; $attempt -lt 120; $attempt++) {
  Start-Sleep -Seconds 1
  $process.Refresh()
  if (Test-LocalEndpoint "http://localhost:3000/health_check") {
    $started = $true
    break
  }
  if ($process.HasExited) {
    break
  }
}

if (-not $started) {
  Write-Host "Startup failed." -ForegroundColor Red
  Show-LogTail "start-local.out"
  Show-LogTail "start-local.err"
  Show-LogTail "gateway"
  Show-LogTail "web"
  Show-LogTail "api"
  Show-LogTail "lore"
  & (Join-Path $root "stop.bat") *> $null
  exit 1
}

Write-Host ""
Write-Host "Yeomai Lore started successfully." -ForegroundColor Green
Write-Host "Web:  http://localhost:3000"
Write-Host "API:  http://localhost:4000"
Write-Host "Lore: lore://localhost:3000"
Write-Host "Logs: $logDir"
exit 0
