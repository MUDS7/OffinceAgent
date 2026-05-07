$ErrorActionPreference = "Stop"

$Port = 8765
$HealthUrl = "http://127.0.0.1:$Port/health"

function Get-ListenerProcessIds {
  try {
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty OwningProcess -Unique
  } catch {
    $lines = netstat -ano -p tcp | Select-String -Pattern ":$Port\s+.*\s+LISTENING\s+\d+"
    return $lines | ForEach-Object {
      if ($_.Line -match "\s+(\d+)\s*$") {
        [int]$Matches[1]
      }
    } | Select-Object -Unique
  }
}

function Get-ProcessCommandLine([int]$ProcessId) {
  try {
    return (Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop).CommandLine
  } catch {
    return ""
  }
}

$listenerPids = @(Get-ListenerProcessIds | Where-Object { $_ })
if ($listenerPids.Count -eq 0) {
  Write-Host "OfficeAgent document service is not running."
  return
}

$isDocumentService = $false
try {
  $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1 -ErrorAction Stop
  $isDocumentService = $health.service -eq "document-service"
} catch {
  $isDocumentService = $false
}

$targetPids = @()
foreach ($listenerPid in $listenerPids) {
  $commandLine = Get-ProcessCommandLine $listenerPid
  if ($isDocumentService -or $commandLine -match "document-service|run\.py|uvicorn") {
    $targetPids += $listenerPid
  }
}

if ($targetPids.Count -eq 0) {
  Write-Warning "Port $Port is in use, but it does not look like the OfficeAgent document service. Leaving it running."
  return
}

foreach ($targetPid in ($targetPids | Select-Object -Unique)) {
  Write-Host "Restarting OfficeAgent document service process $targetPid..."
  Stop-Process -Id $targetPid -Force -ErrorAction Stop
  try {
    Wait-Process -Id $targetPid -Timeout 5 -ErrorAction SilentlyContinue
  } catch {
  }
}
