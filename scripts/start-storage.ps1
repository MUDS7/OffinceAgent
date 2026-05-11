$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$StorageRoot = Join-Path $ProjectRoot ".data"
$SqliteRoot = Join-Path $StorageRoot "sqlite"
$QdrantRoot = Join-Path $StorageRoot "qdrant"
$QdrantContainerName = "officeagent-qdrant"
$QdrantImage = if ($env:OFFICE_AGENT_QDRANT_IMAGE) { $env:OFFICE_AGENT_QDRANT_IMAGE } else { "qdrant/qdrant:latest" }
$QdrantUrl = if ($env:OFFICE_AGENT_QDRANT_URL) { $env:OFFICE_AGENT_QDRANT_URL.TrimEnd("/") } else { "http://127.0.0.1:6333" }

function Test-HttpReady([string]$Url) {
  try {
    Invoke-RestMethod -Uri "$Url/collections" -TimeoutSec 2 -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Test-LocalQdrantUrl([string]$Url) {
  try {
    $uri = [System.Uri]$Url
    return $uri.Scheme -in @("http", "https") -and $uri.Port -eq 6333 -and $uri.Host -in @("127.0.0.1", "localhost", "::1")
  } catch {
    return $false
  }
}

function Get-ListenerProcessIds([int]$Port) {
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

New-Item -ItemType Directory -Force -Path $SqliteRoot | Out-Null
if (!$env:OFFICE_AGENT_SQLITE_PATH) {
  $env:OFFICE_AGENT_SQLITE_PATH = Join-Path $SqliteRoot "office-agent.sqlite3"
}
$SqliteParent = Split-Path -Parent $env:OFFICE_AGENT_SQLITE_PATH
if ($SqliteParent) {
  New-Item -ItemType Directory -Force -Path $SqliteParent | Out-Null
}
Write-Host "SQLite document store: $env:OFFICE_AGENT_SQLITE_PATH"

if (Test-HttpReady $QdrantUrl) {
  Write-Host "Qdrant is ready at $QdrantUrl."
  return
}

if (!(Test-LocalQdrantUrl $QdrantUrl)) {
  throw "Qdrant is not reachable at $QdrantUrl. Set OFFICE_AGENT_QDRANT_URL to a reachable service, or use the default local URL so the dev script can start Docker."
}

$listenerPids = @(Get-ListenerProcessIds -Port 6333 | Where-Object { $_ })
if ($listenerPids.Count -gt 0) {
  throw "Port 6333 is already in use, but Qdrant did not answer at $QdrantUrl. Close that process or point OFFICE_AGENT_QDRANT_URL elsewhere."
}

if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Qdrant is not running and Docker was not found. Install/start Docker Desktop, then run npm run dev again."
}

New-Item -ItemType Directory -Force -Path $QdrantRoot | Out-Null

$containerId = docker ps -aq --filter "name=^/$QdrantContainerName$"
if ($LASTEXITCODE -ne 0) {
  throw "Cannot query Docker containers. Make sure Docker Desktop is running."
}

if ($containerId) {
  Write-Host "Starting existing Qdrant container $QdrantContainerName..."
  docker start $QdrantContainerName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot start existing Qdrant container $QdrantContainerName."
  }
} else {
  Write-Host "Starting Qdrant container $QdrantContainerName..."
  docker run -d `
    --name $QdrantContainerName `
    -p 6333:6333 `
    -p 6334:6334 `
    -v "$($QdrantRoot):/qdrant/storage" `
    $QdrantImage | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Cannot start Qdrant container. Docker may need to pull $QdrantImage or Docker Desktop may not be running."
  }
}

$deadline = (Get-Date).AddSeconds(45)
while ((Get-Date) -lt $deadline) {
  if (Test-HttpReady $QdrantUrl) {
    Write-Host "Qdrant is ready at $QdrantUrl."
    return
  }
  Start-Sleep -Milliseconds 500
}

docker logs --tail 80 $QdrantContainerName
throw "Qdrant container started but did not become ready at $QdrantUrl."
