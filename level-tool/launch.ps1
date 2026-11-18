param(
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$toolDir = $PSScriptRoot
$url = 'http://127.0.0.1:8765'

function Open-StudioBrowser($targetUrl) {
    $browserExe = $null
    try {
        $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction SilentlyContinue).ProgId
        if ($progId) {
            $cmd = (Get-ItemProperty "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
            if ($cmd -match '"([^"]+\.exe)"') {
                $candidate = $matches[1]
                if (Test-Path -LiteralPath $candidate) { $browserExe = $candidate }
            }
        }
    } catch { }

    if (-not $browserExe) {
        $candidates = @(
            'C:\Program Files\Google\Chrome\Application\chrome.exe',
            "$env:LOCALAPPDATA\CocCoc\Browser\Application\browser.exe",
            'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
            'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
            'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
            'C:\Program Files\CocCoc\Browser\Application\browser.exe'
        )
        foreach ($c in $candidates) {
            if (Test-Path -LiteralPath $c) { $browserExe = $c; break }
        }
    }

    if ($browserExe) {
        # Using --new-window guarantees creating a new window on the CURRENT Virtual Desktop (e.g. Desktop 2)
        # without jumping back to an existing window on Desktop 1.
        Start-Process -FilePath $browserExe -ArgumentList @('--new-window', $targetUrl)
    } else {
        Start-Process $targetUrl
    }
}
# If server is already running and healthy, simply open it in browser (unless -Restart requested)
if (-not $Restart) {
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
        if ($health -and $health.app -eq 'FillColoring Studio') {
            Write-Host "FillColoring Studio dang chay. Dang mo trinh duyet..." -ForegroundColor Green
            Open-StudioBrowser $url
            exit 0
        }
    } catch { }
} else {
    # If -Restart requested, terminate old server process if possible
    try {
        $dataDir = Join-Path $toolDir 'data'
        $pidFile = Join-Path $dataDir 'server.pid'
        if (Test-Path $pidFile) {
            $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
            if ($oldPid) { Stop-Process -Id ([int]$oldPid) -Force -ErrorAction SilentlyContinue }
        }
    } catch { }
}

# Find suitable Python 3.10+ with Pillow
$pythonPaths = @()
if ($env:FILLCOLORING_PYTHON) { $pythonPaths += $env:FILLCOLORING_PYTHON }
$pythonPaths += Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
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
    throw 'Khong tim thay Python 3.10+ co Pillow. Cai Python va chay: python -m pip install Pillow; hoac dat bien moi truong FILLCOLORING_PYTHON tro toi python.exe.'
}

$dataDir = Join-Path $toolDir 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$serverPath = Join-Path $toolDir 'server.py'

# Start the background server
Write-Host "Dang khoi dong FillColoring Studio..." -ForegroundColor Cyan
$process = Start-Process -FilePath $pythonExe -ArgumentList @($serverPath, '--no-browser', '--port', '8765') -WorkingDirectory $toolDir -WindowStyle Hidden -PassThru
$process.Id | Set-Content -LiteralPath (Join-Path $dataDir 'server.pid')

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 300
    try {
        $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 1
        if ($health -and $health.app -eq 'FillColoring Studio') {
            Write-Host "Khoi dong thanh cong! Dang mo: $url" -ForegroundColor Green
            Open-StudioBrowser $url
            exit 0
        }
    } catch { }
    if ($process.HasExited) { break }
}

throw 'Khong khoi dong duoc server. Xem file level-tool\data\server-error.log hoac kiem tra cong 8765.'
