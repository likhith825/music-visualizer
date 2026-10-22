# Music Visualizer

A lightweight visualizer that reacts to whatever Windows is playing, including the **Spotify desktop app**. It shows the current Spotify song too.

Everything runs on your PC. The page is served on `127.0.0.1` only, nothing is uploaded, and no internet is needed once it's installed.

## Setup
You need Windows 10 or 11 and Python 3.10 or newer. Install the two packages:

```
pip install -r requirements.txt
```

(`play.bat` also installs them the first time, if they're missing.)

## The files
| File | What it does |
|---|---|
| `ears.py` | Listens to what your PC plays, measures it and streams the numbers to the page |
| `lightshow.js` | Draws the visuals from those numbers |
| `stage.html` | The page the show runs on |
| `play.bat` | Double-click to start it in your browser |
| `neon.ico` | The app icon |

## Run
Pick whichever you like, then play something in Spotify:

- **As an app:** run `pythonw ears.py --app`.
  - It opens in its own window (Edge app mode), with no tabs, address bar or console.
  - Closing the window shuts everything down about 20 seconds later.
  - Running it again while it's open just opens another window.
  - Messages and errors go to `ears.log`.
- **App shortcut:** right-click the desktop → New → Shortcut. As the location, enter the full path to `pythonw.exe`, then the full path to `ears.py` in quotes, then `--app`. You can set `neon.ico` from this folder as its icon.
- **In your normal browser:** double-click `play.bat`, or run `python ears.py --open`. It opens `http://127.0.0.1:8765`.

## Controls
| Key | Action |
|---|---|
| `1` `2` `3` `4` / `Space` | Bars / Halo / Aurora / Warp mode |
| `]` / `[` | Beat effects earlier / later, in 10 ms steps (remembered) |
| `F` | Fullscreen |
| `H` | Hide text |

## How it works
- `ears.py` records the speaker output with WASAPI loopback. That's why it works with the Spotify app, even though Spotify's own audio stream is locked. As each ~10 ms piece of audio arrives (about 100 times a second), it splits the sound into 32 frequency bands and streams them to the page. A separate kick-drum detector looks only at the newest ~10 ms of bass, so it catches a kick about 20 ms after it starts.
- **Beat lock:** once kicks arrive at a steady tempo (5 in a row), the page predicts the next one and fires the beat effects slightly early, 40 ms by default. That cancels the delay from audio capture and the screen, so the effects land right on the beat. The status line then shows "beat locked". With irregular rhythms it reacts to each detected kick instead. If the beat still feels late or early on your setup, tune it with `]` and `[`.
- The song name comes from the Spotify window title (`Artist - Song`), so no Spotify login is needed.
- `lightshow.js` draws with plain 2D canvas at no more than 60 fps, and stops drawing when nothing is playing. The effects use cheap tricks:
  - **Trails:** fade the last frame instead of clearing it.
  - **Glow:** a tiny stretched copy of the canvas.
  - Shapes are drawn in a few batched calls.

## Troubleshooting
- **Bars don't move:** make sure sound is actually coming out of your default speaker or headphones. If you switch output devices, it picks up the new one within a few seconds of silence.
- **No song name:** the name only shows while Spotify is playing. Ads and podcasts may not show one.
- **"Port 8765 is busy":** it's already running. Just open `http://127.0.0.1:8765`.
