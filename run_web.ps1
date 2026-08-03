# Launch the web app: FastAPI backend + Vite dev server.
#
# The backend spawns mcp_server.py itself over stdio, so there is no third
# process to start. Ctrl+C stops the frontend; the backend window closes with it.

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

if (-not (Test-Path (Join-Path $root "frontend/node_modules"))) {
    Write-Host "Installing frontend dependencies..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend")
    npm install --no-fund --no-audit
    Pop-Location
}

# The backend also reads .env (project root, then backend/), so only warn when
# neither the shell environment nor a .env file can supply the key.
$hasEnvFile = (Test-Path (Join-Path $root ".env")) -or (Test-Path (Join-Path $root "backend/.env"))
if (-not $env:ANTHROPIC_API_KEY -and -not $hasEnvFile) {
    Write-Host "ANTHROPIC_API_KEY not found - 'Ask Claude' and 'Generate code' will fail." -ForegroundColor Yellow
    Write-Host "Fix: copy .env.example to .env and add your key, or set the variable." -ForegroundColor Yellow
    Write-Host "The dataset, chart, and model tabs work without it." -ForegroundColor Yellow
}

Write-Host "Starting API on http://127.0.0.1:8000 ..." -ForegroundColor Cyan
$api = Start-Process -PassThru -WorkingDirectory $root `
    -FilePath "uv" -ArgumentList @("run", "uvicorn", "backend.main:app", "--port", "8000")

try {
    Write-Host "Starting UI on http://localhost:5173 ..." -ForegroundColor Cyan
    Push-Location (Join-Path $root "frontend")
    npm run dev
}
finally {
    Pop-Location
    if ($api -and -not $api.HasExited) {
        Write-Host "Stopping API..." -ForegroundColor Cyan
        # /T kills the whole tree. `uv` spawns uvicorn, which spawns
        # mcp_server.py -- stopping only the top process leaves uvicorn holding
        # port 8000, so the next run silently fails to bind.
        & taskkill /PID $api.Id /T /F *> $null
    }
}
