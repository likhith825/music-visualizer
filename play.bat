@echo off
rem Starts the music visualizer and opens it in your browser.
cd /d "%~dp0"
python -c "import pyaudiowpatch, numpy" 2>nul || python -m pip install PyAudioWPatch numpy
python ears.py --open
pause
