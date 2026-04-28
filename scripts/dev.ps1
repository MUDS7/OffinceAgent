$ErrorActionPreference = "Stop"

if (Test-Path "services/document-service/.venv/Scripts/python.exe") {
  $env:Path = "$(Resolve-Path services/document-service/.venv/Scripts);$env:Path"
} elseif (Test-Path "services/document-service/.packages") {
  $env:PYTHONPATH = "$(Resolve-Path services/document-service/.packages);$env:PYTHONPATH"
}

npm run dev
