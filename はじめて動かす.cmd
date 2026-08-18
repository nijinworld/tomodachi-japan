@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo   Ranius日本語 — ともだちじゃぱん運用システム
echo.

where node > nul 2>&1
if errorlevel 1 (
  echo   Node.js が入っていません。https://nodejs.org からインストールしてください（18以上）。
  echo.
  pause
  exit /b 1
)

if not exist "data\lessons.json" (
  echo   データがないので、デモデータを作ります...
  echo   ※ ここで作られる数字はすべてデモです。実績ではありません。
  echo.
  node scripts\seed.js
)

echo   起動します。ブラウザで http://localhost:5173 を開いてください。
echo.
echo   デモのログイン: u_admin  ／ 合言葉 ranius-demo-2026
echo   （実データを入れる前に node scripts\set-passcode.js で入れ直してください）
echo   止めるときは、この画面で Ctrl+C を押してください。
echo.
start "" http://localhost:5173
node server\index.js
pause
