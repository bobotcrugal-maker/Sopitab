@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing server dependencies...
  npm install
)
echo Starting PisoTab server...
npm start
pause
