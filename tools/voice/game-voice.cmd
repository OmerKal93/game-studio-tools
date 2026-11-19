@echo off
rem Portable launcher: uses the venv in bin\voice, sets nothing system-wide.
set "BINV=%~dp0..\..\bin\voice"
set "HF_HOME=%BINV%\hf"
rem ffmpeg for torchcodec/loudness; torch\lib holds the cuBLAS/cuDNN DLLs that ctranslate2 (Whisper) needs
set "PATH=%~dp0..\..\bin;%BINV%\venv\Lib\site-packages\torch\lib;%PATH%"
"%BINV%\venv\Scripts\python.exe" -I "%~dp0game_voice.py" %*
