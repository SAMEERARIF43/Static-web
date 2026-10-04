$serverPath = Join-Path $PSScriptRoot "server.js"
$process = Start-Process -FilePath "node" -ArgumentList ('"{0}"' -f $serverPath) -PassThru -NoNewWindow
Start-Sleep -Seconds 2
Write-Host "Server started, testing search..."