@echo off
title ADC VR Training POC - local demo server (static variant)
cd /d "%~dp0"
echo.
echo  ============================================================
echo   Abu Dhabi Customs - VR Training POC (static 3D variant)
echo   Serving on http://localhost:8020
echo.
echo   Keep this window OPEN while using the demo.
echo   The local server enables the microphone, images and AI.
echo.
echo   For the voice-enabled variant instead, run:
echo     npm install  ^&^&  set GEMINI_API_KEY=yourkey ^&^& node server.js
echo  ============================================================
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8020/public/ADC_POC_3D.html"
python -m http.server 8020
if errorlevel 1 (
  echo.
  echo Python was not found. Install Python or run any static server in this folder.
  pause
)
