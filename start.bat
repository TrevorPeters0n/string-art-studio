@echo off
rem Launch String Art Studio in your default browser.
cd /d "%~dp0"
where python >nul 2>nul && (python serve.py %1 & goto :eof)
where py     >nul 2>nul && (py serve.py %1     & goto :eof)
where node   >nul 2>nul && (node serve.mjs %1  & goto :eof)
echo Could not find python or node on PATH.
pause
