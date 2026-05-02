#Requires -Version 5.1
<#
.SYNOPSIS
    Запускает Ollama (serve), если ещё не запущена.
.NOTES
    Логи: %LOCALAPPDATA%\ollama-windows-autostart\logs\
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$RootDir = Join-Path $env:LOCALAPPDATA 'ollama-windows-autostart'
$LogDir = Join-Path $RootDir 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$script:LogFile = Join-Path $LogDir ("ollama-{0:yyyy-MM-dd}.log" -f (Get-Date))

function Write-Log {
    param([string]$Message, [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO')
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "$ts [$Level] $Message"
    try {
        Add-Content -LiteralPath $script:LogFile -Value $line -Encoding utf8 -ErrorAction Stop
    }
    catch {
        [Console]::Error.WriteLine($line)
    }
    if ($Level -eq 'ERROR') { Write-LogSafe $line }
}

function Write-LogSafe {
    param([string]$Line)
    try {
        [Console]::Error.WriteLine($Line)
    }
    catch { /* ignore */ }
}

function Test-OllamaListening {
    param([string]$HostName = '127.0.0.1', [int]$Port = 11434)
    try {
        $c = Test-NetConnection -ComputerName $HostName -Port $Port -WarningAction SilentlyContinue -ErrorAction Stop
        return [bool]$c.TcpTestSucceeded
    }
    catch {
        return $false
    }
}

function Resolve-OllamaExe {
    $cmd = Get-Command -Name 'ollama.exe' -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }
    $candidates = @(
        (Join-Path ${env:ProgramFiles} 'Ollama\ollama.exe'),
        (Join-Path ${env:LOCALAPPDATA} 'Programs\Ollama\ollama.exe')
    )
    $pf86 = ${env:ProgramFiles(x86)}
    if (-not [string]::IsNullOrWhiteSpace($pf86)) {
        $candidates += (Join-Path $pf86 'Ollama\ollama.exe')
    }
    foreach ($p in $candidates) {
        if ($p -and (Test-Path -LiteralPath $p)) {
            return $p
        }
    }
    return $null
}

Write-Log '=== ollama-start.ps1 started ==='

if (Test-OllamaListening) {
    Write-Log 'Порт 11434 уже доступен — сервер Ollama, вероятно, уже работает.'
    exit 0
}

$exe = Resolve-OllamaExe
if (-not $exe) {
    Write-Log 'Не найден ollama.exe (PATH / Program Files / LocalAppData).' 'ERROR'
    exit 1
}

Write-Log "Запуск: `"$exe`" serve"

try {
    Start-Process -FilePath $exe -ArgumentList @('serve') -WindowStyle Hidden -WorkingDirectory (Split-Path -Parent $exe)
}
catch {
    Write-Log ("Start-Process failed: {0}" -f $_.Exception.Message) 'ERROR'
    exit 1
}

Start-Sleep -Seconds 3

if (Test-OllamaListening) {
    Write-Log 'Ollama слушает 127.0.0.1:11434 — OK.'
    exit 0
}

Write-Log 'После запуска порт 11434 недоступен. Проверьте установку / службу Ollama.' 'WARN'
exit 2
