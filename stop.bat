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
$root = Split-Path -Parent $env:YEOMAI_BAT_SELF
$runDir = Join-Path $root "data\local\run"
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

function Get-OccupiedPorts {
  $tcp = Get-NetTCPConnection -State Listen -LocalPort $ports -ErrorAction SilentlyContinue
  $udp = Get-NetUDPEndpoint -LocalPort $ports -ErrorAction SilentlyContinue
  return @($tcp) + @($udp) |
    Where-Object { $_ } |
    Sort-Object LocalPort |
    Select-Object LocalAddress, LocalPort, OwningProcess
}

function Stop-ProcessTree([int]$processId) {
  if ($processId -le 0) {
    return
  }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $process) {
    return
  }
  & taskkill.exe /PID $processId /T /F *> $null
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
    $allowedHost = $process.Name -in @("node.exe", "bash.exe", "sh.exe", "loreserver.exe")
    $belongsToProject =
      $commandLine.ToLowerInvariant().Replace("/", "\").Contains($rootLower) -or
      ($pidFile -eq "api.pid" -and $commandLine -match "src[\\/]+index\.ts")
    if ($allowedHost -and $belongsToProject) {
      [void]$ids.Add($parsedPid)
    }
  }

  return @($ids)
}

Write-Host "Stopping Yeomai Lore..."

$candidateIds = New-Object System.Collections.Generic.HashSet[int]
foreach ($projectPid in Get-ProjectProcessIds) {
  [void]$candidateIds.Add([int]$projectPid)
}

$deadline = (Get-Date).AddSeconds(20)
do {
  foreach ($processId in $candidateIds) {
    Stop-ProcessTree $processId
  }
  foreach ($processId in (Get-ProjectProcessIds)) {
    [void]$candidateIds.Add([int]$processId)
    Stop-ProcessTree $processId
  }

  $occupied = Get-OccupiedPorts
  $remainingProcesses = Get-ProjectProcessIds
  if ($occupied.Count -eq 0 -and $remainingProcesses.Count -eq 0) {
    break
  }
  Start-Sleep -Seconds 1
} while ((Get-Date) -lt $deadline)

foreach ($pidFile in $pidFiles) {
  $path = Join-Path $runDir $pidFile
  Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
}

$occupied = Get-OccupiedPorts
$remainingProcesses = Get-ProjectProcessIds
if ($occupied.Count -gt 0 -or $remainingProcesses.Count -gt 0) {
  if ($remainingProcesses.Count -gt 0) {
    Write-Host "Some Yeomai Lore processes are still running:" -ForegroundColor Red
    Get-Process -Id $remainingProcesses |
      Select-Object Id, ProcessName, StartTime, Path |
      Format-Table -AutoSize
  }
  if ($occupied.Count -gt 0) {
    Write-Host "Some required ports are still in use:" -ForegroundColor Red
  }
  $occupied | Format-Table -AutoSize
  exit 1
}

Write-Host "Yeomai Lore stopped."
exit 0
