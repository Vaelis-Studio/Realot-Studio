@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install Node.js, then run this again.
  echo.
  pause
  exit /b 1
)
node "%~dp0server.mjs" --show-token
if errorlevel 1 (
  echo Could not read or create the local Realot MCP pairing token.
  echo.
  pause
  exit /b 1
)
echo.
echo Copy the 64-character token above into Realot Studio's AI Bridge panel.
echo Keep the token private. This command does not start the MCP server.
echo.
pause
