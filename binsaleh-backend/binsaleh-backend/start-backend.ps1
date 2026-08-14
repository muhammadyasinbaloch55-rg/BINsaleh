$ErrorActionPreference = 'SilentlyContinue'
# Kill any existing server.js process so we restart with the new code
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Seconds 2

# Clear stale VERCEL vars for this session (they make server.js skip listen())
$env:VERCEL = ''
$env:VERCEL_ENV = ''
$env:VERCEL_URL = ''

# Launch fully detached
$p = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentList 'server.js' `
  -WorkingDirectory 'F:\BINSALEH-STORE\binsaleh-backend\binsaleh-backend' `
  -RedirectStandardOutput 'F:\BINSALEH-STORE\binsaleh-backend\binsaleh-backend\server.log' `
  -RedirectStandardError 'F:\BINSALEH-STORE\binsaleh-backend\binsaleh-backend\server.err.log' `
  -WindowStyle Hidden -PassThru

Write-Output "Started PID=$($p.Id)"
