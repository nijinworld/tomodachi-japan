@echo off
chcp 65001 > nul
cd /d "%~dp0"

rem data/ を控えて、30世代より古いものを消します。
rem Windows のタスクスケジューラに、これを毎日1回登録してください。
rem
rem   1. スタート →「タスク スケジューラ」
rem   2. 「基本タスクの作成」→ 名前：Ranius バックアップ
rem   3. トリガー：毎日／時刻はサーバが動いている時間帯（例 03:00）
rem   4. 操作：「プログラムの開始」→ このファイルを選ぶ
rem   5. 「最上位の特権で実行する」は不要です
rem
rem 動いているかは backups\ を見るか、node scripts\backup.js --list で確認してください。

node scripts\backup.js --keep 30 >> backups\backup.log 2>&1
