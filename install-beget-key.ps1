# Одноразовая установка публичного ключа на root@89.169.39.244 (нужен пароль root через консоль).
$ErrorActionPreference = 'Stop'
$pub = Join-Path $env:USERPROFILE '.ssh\id_ed25519_beget_instinctive.pub'
if (-not (Test-Path $pub)) {
    Write-Error "Нет файла: $pub"
}
$pwdSecure = Read-Host 'Пароль root (для этого сервера)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pwdSecure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $env:BEGET_ROOT_PASSWORD = $plain
    dotnet run --project "$PSScriptRoot\ssh-install-key\install-key.csproj" --no-launch-profile
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) | Out-Null
    Remove-Item Env:BEGET_ROOT_PASSWORD -ErrorAction SilentlyContinue
}
