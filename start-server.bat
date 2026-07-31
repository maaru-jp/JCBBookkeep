@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  刷卡紀錄 - 本機伺服器
echo  =======================
echo  請在瀏覽器開啟： http://localhost:8080
echo  按 Ctrl+C 可停止
echo.
python -m http.server 8080
if errorlevel 1 (
  echo.
  echo Python 未安裝或不在 PATH 中。
  echo 請安裝 Python，或改用 start-server.ps1
  pause
)
