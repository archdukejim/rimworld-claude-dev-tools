@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd server
call npm install
call npm run build
start "RimSynapse MCP Manager" "C:\Program Files\nodejs\node.exe" build/manager.js
ping 127.0.0.1 -n 3 > nul
start http://localhost:4001
