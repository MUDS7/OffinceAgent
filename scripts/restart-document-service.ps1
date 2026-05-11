$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ServiceRoot = Join-Path $ProjectRoot "services/document-service"
$VenvPython = Join-Path $ServiceRoot ".venv/Scripts/python.exe"
$RunScript = Join-Path $ServiceRoot "run.py"
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
$isDocumentService = $false
if ($listenerPids.Count -gt 0) {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1 -ErrorAction Stop
    $isDocumentService = $health.service -eq "document-service"
  } catch {
    $isDocumentService = $false
  }
}

$targetPids = @()
foreach ($listenerPid in $listenerPids) {
  $commandLine = Get-ProcessCommandLine $listenerPid
  if ($isDocumentService -or $commandLine -match "document-service|run\.py|uvicorn") {
    $targetPids += $listenerPid
  }
}

if ($listenerPids.Count -gt 0 -and $targetPids.Count -eq 0) {
  throw "Port $Port is in use, but it does not look like the OfficeAgent document service. Cannot restart safely."
}

foreach ($targetPid in ($targetPids | Select-Object -Unique)) {
  Write-Host "Restarting OfficeAgent document service process $targetPid..."
  Stop-Process -Id $targetPid -Force -ErrorAction Stop
  try {
    Wait-Process -Id $targetPid -Timeout 5 -ErrorAction SilentlyContinue
  } catch {
  }
}

if (!(Test-Path $RunScript)) {
  throw "Document service entrypoint not found: $RunScript"
}

$python = if (Test-Path $VenvPython) { $VenvPython } else { "python" }

if (Test-Path (Join-Path $ServiceRoot ".packages")) {
  $env:PYTHONPATH = "$(Resolve-Path (Join-Path $ServiceRoot ".packages"));$env:PYTHONPATH"
}

Write-Host "Starting OfficeAgent document service on port $Port..."
$process = Start-Process `
  -FilePath $python `
  -ArgumentList "run.py" `
  -WorkingDirectory $ServiceRoot `
  -WindowStyle Hidden `
  -PassThru

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod -Uri $HealthUrl -TimeoutSec 1 -ErrorAction Stop
    if ($health.service -eq "document-service") {
      Write-Host "OfficeAgent document service is ready (pid $($process.Id))."
      return
    }
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

throw "Document service did not become healthy at $HealthUrl"
