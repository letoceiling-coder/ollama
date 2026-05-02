$ErrorActionPreference = 'Continue'
Write-Host 'Reverse SSH: server 127.0.0.1:11434 -> this PC Ollama :11434'
Write-Host 'Keep this window open or install as Scheduled Task / NSSM.'
while ($true) {
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ssh -N beget-ollama-tunnel"
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 beget-ollama-tunnel
    Write-Host "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') SSH exited code=$LASTEXITCODE, reconnect in 5s..."
    Start-Sleep -Seconds 5
}
