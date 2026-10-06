Add-Type -AssemblyName System.Drawing
$path = "c:\Users\samee\OneDrive\Documents\Default Project\Static-web\public\websites picture.webp"
$img = [System.Drawing.Image]::FromFile($path)
Write-Host "Dimensions: $($img.Width) x $($img.Height)"
Write-Host "Pixel format: $($img.PixelFormat)"
Write-Host "File size: $((Get-Item $path).Length) bytes"
$img.Dispose()
