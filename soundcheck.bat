@echo off
rem Soundcheck: one-time setup before the show.
rem Installs the two Python packages, puts a "Music Visualizer" shortcut with the
rem neon icon on your desktop, then opens the visualizer as an app.
rem Run it again if you move this folder, since the shortcut points to this folder.
cd /d "%~dp0"

python --version >nul 2>&1
if errorlevel 1 (
  echo Python wasn't found. Install it from python.org and tick "Add python.exe to PATH".
  echo See step 1 in README.md.
  pause
  exit /b 1
)

python -c "import pyaudiowpatch, numpy" 2>nul
if errorlevel 1 (
  echo Installing the two packages the visualizer needs...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Installing failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem pythonw.exe is Python without a console window; it sits next to python.exe.
for /f "usebackq delims=" %%p in (`python -c "import os, sys; print(os.path.join(os.path.dirname(sys.executable), 'pythonw.exe'))"`) do set "PYW=%%p"
set "VIS=%~dp0"

powershell -NoProfile -Command "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop') + '\Music Visualizer.lnk'); $s.TargetPath = $env:PYW; $s.Arguments = [char]34 + $env:VIS + 'ears.py' + [char]34 + ' --app'; $s.WorkingDirectory = $env:VIS; $s.IconLocation = $env:VIS + 'neon.ico'; $s.Description = 'Music visualizer'; $s.Save()"
if errorlevel 1 (
  echo Couldn't create the desktop shortcut, but you can always start it with this file.
) else (
  echo Added a "Music Visualizer" shortcut to your desktop. Use that from now on.
)

echo Starting the show...
start "" "%PYW%" "%VIS%ears.py" --app
ping -n 4 127.0.0.1 >nul
