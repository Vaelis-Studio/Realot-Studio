@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install Node.js, then run this again.
  echo.
  pause
  exit /b 1
)
node "%~dp0configure-claude-desktop.mjs"
if errorlevel 1 (
  echo.
  echo Claude Desktop setup did not complete. Read the message above.
) else (
  echo.
  echo Restart Claude Desktop before using the Realot MCP bridge.
)
echo.
pause
