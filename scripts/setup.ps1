$ErrorActionPreference = "Stop"

$ServiceRoot = "services/document-service"
$VenvPython = Join-Path $ServiceRoot ".venv/Scripts/python.exe"
$LocalPackages = Join-Path $ServiceRoot ".packages"

Write-Host "Installing Node dependencies..."
npm install

Write-Host "Creating Python virtual environment..."
try {
  python -m venv (Join-Path $ServiceRoot ".venv")
} catch {
  Write-Warning "Unable to create a Python venv with the current interpreter. Falling back to local package target."
}

if (Test-Path $VenvPython) {
  Write-Host "Installing Python dependencies into venv..."
  & $VenvPython -m pip install --upgrade pip
  & $VenvPython -m pip install -r (Join-Path $ServiceRoot "requirements.txt")
} else {
  Write-Host "Installing Python dependencies into $LocalPackages..."
  New-Item -ItemType Directory -Force -Path $LocalPackages | Out-Null
  python -m pip install --upgrade --target $LocalPackages -r (Join-Path $ServiceRoot "requirements.txt")
}

Write-Host "OfficeAgent environment is ready."
