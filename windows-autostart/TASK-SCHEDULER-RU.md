# Автозапуск Ollama и reverse SSH на Windows

Файлы в этой папке:

| Файл | Назначение |
|------|------------|
| `ollama-start.ps1` | Запускает `ollama serve`, если порт `11434` ещё не слушает |
| `tunnel-start.ps1` | Держит reverse SSH `-R` с переподключением |

Логи (UTF-8): `%LOCALAPPDATA%\ollama-windows-autostart\logs\`

- `ollama-YYYY-MM-DD.log`
- `tunnel-YYYY-MM-DD.log`

---

## Без пароля (важно)

1. **SSH** — используйте ключ **без passphrase** (или настройте Windows OpenSSH Agent и добавьте ключ один раз вручную; для полностью автоматического входа после перезагрузки без ввода passphrase проще ключ без пароля).
2. На сервере в `authorized_keys` должен быть ваш **публичный** ключ.
3. Укажите верный путь к **приватному** ключу в `tunnel-start.ps1` или через `SSH_TUNNEL_IDENTITY_FILE`.

---

## Настройка туннеля

Отредактируйте в начале `tunnel-start.ps1` переменные по умолчанию **или** задайте переменные окружения пользователя Windows:

| Переменная | Пример |
|------------|--------|
| `SSH_TUNNEL_REMOTE_HOST` | `89.169.39.244` |
| `SSH_TUNNEL_REMOTE_USER` | `root` |
| `SSH_TUNNEL_IDENTITY_FILE` | `C:\Users\Вы\.ssh\id_ed25519_beget_nopass` |
| `SSH_TUNNEL_REMOTE_BIND_PORT` | `11434` |
| `SSH_TUNNEL_LOCAL_HOST` | `127.0.0.1` |
| `SSH_TUNNEL_LOCAL_PORT` | `11434` |
| `SSH_TUNNEL_RECONNECT_SECONDS` | `15` |

На VPS в `sshd_config` для удалённой привязки может понадобиться `GatewayPorts` / `AllowTcpForwarding` — это настраивается на сервере.

---

## Вариант A — Планировщик заданий (`schtasks`)

Подставьте **свой** абсолютный путь к папке со скриптами (ниже пример `C:\server\windows-autostart`).

### 1) Ollama (через ~15 сек после входа)

```cmd
schtasks /Create /F /TN "Ollama Serve Autostart" /SC ONLOGON /DELAY 0000:15 /RL LIMITED /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\server\windows-autostart\ollama-start.ps1\""
```

### 2) Reverse SSH (через ~60 сек после входа — чтобы успел подняться Ollama)

```cmd
schtasks /Create /F /TN "Ollama Reverse SSH Tunnel" /SC ONLOGON /DELAY 0001:00 /RL LIMITED /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"C:\server\windows-autostart\tunnel-start.ps1\""
```

Проверка:

```cmd
schtasks /Query /TN "Ollama Serve Autostart"
schtasks /Query /TN "Ollama Reverse SSH Tunnel"
```

Удаление при необходимости:

```cmd
schtasks /Delete /TN "Ollama Serve Autostart" /F
schtasks /Delete /TN "Ollama Reverse SSH Tunnel" /F
```

---

## Вариант B — Планировщик из PowerShell (`Register-ScheduledTask`)

Запустите PowerShell **от имени того пользователя**, под которым вы входите в Windows. Замените `$ScriptRoot`:

```powershell
$ScriptRoot = 'C:\server\windows-autostart'
$exe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

Register-ScheduledTask -TaskName 'Ollama Serve Autostart' -Force `
  -Action (New-ScheduledTaskAction -Execute $exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptRoot\ollama-start.ps1`"") `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -Delay (New-TimeSpan -Seconds 15)) `
  -RunLevel Limited

Register-ScheduledTask -TaskName 'Ollama Reverse SSH Tunnel' -Force `
  -Action (New-ScheduledTaskAction -Execute $exe -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptRoot\tunnel-start.ps1`"") `
  -Trigger (New-ScheduledTaskTrigger -AtLogOn -Delay (New-TimeSpan -Seconds 60)) `
  -RunLevel Limited
```

Если ваш билд Windows не поддерживает `-Delay` у триггера, используйте **вариант A** (`schtasks /DELAY`).

---

## Ручная проверка перед автозапуском

В PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\server\windows-autostart\ollama-start.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\server\windows-autostart\tunnel-start.ps1"
```

Туннель скрипт не завершит работу сам — это нормально; остановка: закрыть задачу в Диспетчере задач или завершить процесс `ssh.exe`.

---

## Замечания по политике выполнения

Если скрипты заблокированы, один раз для текущего пользователя:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Или оставляйте только `-ExecutionPolicy Bypass` в строке задачи (как в примерах выше).
