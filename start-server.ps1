Set-Location $PSScriptRoot
Write-Host ""
Write-Host " 刷卡紀錄 - 本機伺服器"
Write-Host " ======================="
Write-Host " 請在瀏覽器開啟： http://localhost:8080"
Write-Host " 按 Ctrl+C 可停止"
Write-Host ""
python -m http.server 8080
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "Python 未安裝或不在 PATH 中，請先安裝 Python。" -ForegroundColor Yellow
  Read-Host "按 Enter 結束"
}
