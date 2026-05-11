$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$StorageRoot = Join-Path $ProjectRoot ".data"
$SqliteRoot = Join-Path $StorageRoot "sqlite"
$QdrantRoot = Join-Path $StorageRoot "qdrant"

New-Item -ItemType Directory -Force -Path $SqliteRoot | Out-Null
if (!$env:OFFICE_AGENT_SQLITE_PATH) {
  $env:OFFICE_AGENT_SQLITE_PATH = Join-Path $SqliteRoot "office-agent.sqlite3"
}
$SqliteParent = Split-Path -Parent $env:OFFICE_AGENT_SQLITE_PATH
if ($SqliteParent) {
  New-Item -ItemType Directory -Force -Path $SqliteParent | Out-Null
}
Write-Host "SQLite document store: $env:OFFICE_AGENT_SQLITE_PATH"

New-Item -ItemType Directory -Force -Path $QdrantRoot | Out-Null
if (!$env:OFFICE_AGENT_QDRANT_PATH) {
  $env:OFFICE_AGENT_QDRANT_PATH = $QdrantRoot
}
$QdrantParent = Split-Path -Parent $env:OFFICE_AGENT_QDRANT_PATH
if ($QdrantParent -and [IO.Path]::HasExtension($env:OFFICE_AGENT_QDRANT_PATH)) {
  New-Item -ItemType Directory -Force -Path $QdrantParent | Out-Null
} else {
  New-Item -ItemType Directory -Force -Path $env:OFFICE_AGENT_QDRANT_PATH | Out-Null
}
Write-Host "Embedded Qdrant store: $env:OFFICE_AGENT_QDRANT_PATH"
