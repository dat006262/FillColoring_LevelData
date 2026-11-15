$ErrorActionPreference = 'Stop'
$toolDir = $PSScriptRoot
$url = 'http://127.0.0.1:8765'
try {
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    if ($health.app -eq 'FillColoring Studio') {
        Start-Process $url
        exit 0
    }
} catch { }

$pythonPaths = @()
if ($env:FILLCOLORING_PYTHON) { $pythonPaths += $env:FILLCOLORING_PYTHON }
$runtimePackages = Get-AppxPackage -Name '*CodexPrimaryRuntime*' -ErrorAction SilentlyContinue | Sort-Object Version -Descending
foreach ($package in $runtimePackages) {
    $pythonPaths += Join-Path $package.InstallLocation 'dependencies\python\python.exe'
}
$pythonPaths += Get-ChildItem -Path 'C:\Program Files\WindowsApps\OpenAI.CodexPrimaryRuntime*\dependencies\python\python.exe' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
$ordinaryPython = Get-Command python.exe -ErrorAction SilentlyContinue
if ($ordinaryPython -and $ordinaryPython.Source -notlike '*\Microsoft\WindowsApps\*') { $pythonPaths += $ordinaryPython.Source }
$pythonExe = $null
foreach ($candidate in ($pythonPaths | Select-Object -Unique)) {
    if (Test-Path -LiteralPath $candidate) {
        & $candidate -c 'import PIL; import sys; assert sys.version_info >= (3,10)' 2>$null
        if ($LASTEXITCODE -eq 0) { $pythonExe = $candidate; break }
    }
}
if (-not $pythonExe) {
    throw 'Khong tim thay Python 3.10+ co Pillow. Cai Python va chay: python -m pip install Pillow; hoac dat FILLCOLORING_PYTHON tro toi python.exe.'
}
$dataDir = Join-Path $toolDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$serverPath = Join-Path $toolDir 'server.py'
$process = Start-Process -FilePath $pythonExe -ArgumentList @('"' + $serverPath + '"', '--no-browser', '--port', '8765') -WorkingDirectory $toolDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log')
$process.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
        if ($health.app -eq 'FillColoring Studio') { Start-Process $url; exit 0 }
    } catch { }
    if ($process.HasExited) { break }
}
throw 'Khong khoi dong duoc. Xem level-tool\data\server-error.log; cong 8765 co the dang duoc su dung.'
