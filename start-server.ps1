$process = Start-Process -FilePath "node" -ArgumentList "C:\Users\samee\OneDrive\Documents\Default Project\Static-web\server.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2
Write-Host "Server started, testing search..."