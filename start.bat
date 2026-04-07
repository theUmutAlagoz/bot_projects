@echo off
cd /d "%~dp0"
echo Starting PolySniper...
npx ts-node src/index.ts
pause
