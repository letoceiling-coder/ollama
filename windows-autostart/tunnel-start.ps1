#Requires -Version 5.1
<#
.SYNOPSIS
    Обратный SSH-туннель: на VPS слушает 127.0.0.1:RemoteBindPort и пробрасывает на локальный Ollama.
.NOTES
    Переменные окружения (необязательно):
      SSH_TUNNEL_REMOTE_HOST, SSH_TUNNEL_REMOTE_USER, SSH_TUNNEL_IDENTITY_FILE,
      SSH_TUNNEL_REMOTE_BIND_PORT, SSH_TUNNEL_LOCAL_HOST, SSH_TUNNEL_LOCAL_PORT,
      SSH_TUNNEL_RECONNECT_SECONDS,
      SSH_TUNNEL_EXTRA_ARGS — строка с дополнительными аргументами ssh (разделитель — пробел).
    Логи: %LOCALAPPDATA%\ollama-windows-autostart\logs\
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

# --- Конфигурация по умолчанию ---
$RemoteHost = if ($env:SSH_TUNNEL_REMOTE_HOST) { $env:SSH_TUNNEL_REMOTE_HOST } else { '89.169.39.244' }
$RemoteUser = if ($env:SSH_TUNNEL_REMOTE_USER) { $env:SSH_TUNNEL_REMOTE_USER } else { 'root' }
$IdentityFile = if ($env:SSH_TUNNEL_IDENTITY_FILE) {
    $env:SSH_TUNNEL_IDENTITY_FILE
}
else {
    Join-Path $env:USERPROFILE '.ssh\id_ed25519_beget_nopass'
}

[int]$RemoteBindPort = if ($env:SSH_TUNNEL_REMOTE_BIND_PORT -match '^\d+$') {
    [int]$env:SSH_TUNNEL_REMOTE_BIND_PORT
}
else {
    11434
}

$LocalHost = if ($env:SSH_TUNNEL_LOCAL_HOST) { $env:SSH_TUNNEL_LOCAL_HOST } else { '127.0.0.1' }
[int]$LocalPort = if ($env:SSH_TUNNEL_LOCAL_PORT -match '^\d+$') {
    [int]$env:SSH_TUNNEL_LOCAL_PORT
}
else {
    11434
}

[int]$ReconnectSeconds = if ($env:SSH_TUNNEL_RECONNECT_SECONDS -match '^\d+$') {
    [int]$env:SSH_TUNNEL_RECONNECT_SECONDS
}
else {
    15
}

$RootDir = Join-Path $env:LOCALAPPDATA 'ollama-windows-autostart'
$LogDir = Join-Path $RootDir 'logs'
if (-not (Test-Path -LiteralPath $LogDir)) {
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

$script:LogFile = Join-Path $LogDir ("tunnel-{0:yyyy-MM-dd}.log" -f (Get-Date))

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
}

function Resolve-SshExe {
    $cmd = Get-Command -Name 'ssh.exe' -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source) {
        return $cmd.Source
    }
    $p = Join-Path $env:SystemRoot 'System32\OpenSSH\ssh.exe'
    if (Test-Path -LiteralPath $p) {
        return $p
    }
    return $null
}

Write-Log '=== tunnel-start.ps1: цикл с переподключением ==='
Write-Log ("Туннель: на сервере 127.0.0.1:${RemoteBindPort} -> локально ${LocalHost}:${LocalPort} (${RemoteUser}@${RemoteHost})")

if (-not (Test-Path -LiteralPath $IdentityFile)) {
    Write-Log ("SSH-ключ не найден: $IdentityFile") 'ERROR'
    Write-Log 'Задайте SSH_TUNNEL_IDENTITY_FILE или скопируйте ключ без парольной фразы для входа без запроса пароля.' 'ERROR'
    exit 1
}

$ssh = Resolve-SshExe
if (-not $ssh) {
    Write-Log 'Не найден ssh.exe. Установите компонент «Клиент OpenSSH» (Параметры → Приложения → Дополнительные компоненты).' 'ERROR'
    exit 1
}

while ($true) {
    Write-Log 'Запуск ssh ...'

    $argList = @(
        '-N',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=4',
        '-o', 'TCPKeepAlive=yes',
        '-o', 'StrictHostKeyChecking=accept-new',
        '-i', $IdentityFile,
        '-R', "${RemoteBindPort}:${LocalHost}:${LocalPort}",
        "${RemoteUser}@${RemoteHost}"
    )

    if ($env:SSH_TUNNEL_EXTRA_ARGS) {
        $extra = $env:SSH_TUNNEL_EXTRA_ARGS.Trim()
        if ($extra.Length -gt 0) {
            Write-Log "SSH_TUNNEL_EXTRA_ARGS: $extra"
            # простое разбиение по пробелам (без кавычек внутри)
            $argList += ($extra -split '\s+' | Where-Object { $_ })
        }
    }

    try {
        $proc = Start-Process -FilePath $ssh -ArgumentList $argList -WindowStyle Hidden -PassThru -Wait
        $exit = $proc.ExitCode
    }
    catch {
        Write-Log ("Ошибка запуска ssh: {0}" -f $_.Exception.Message) 'ERROR'
        $exit = -1
    }

    Write-Log ("ssh завершился (ExitCode=$exit). Повтор через ${ReconnectSeconds} с.") 'WARN'
    Start-Sleep -Seconds $ReconnectSeconds
}
