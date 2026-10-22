"""Music visualizer server.

Captures whatever Windows is playing (e.g. the Spotify app) through WASAPI
loopback, turns it into 32 frequency bands plus a kick-drum beat signal and
streams them to the page at http://127.0.0.1:8765 with Server-Sent Events,
as soon as each new piece of audio arrives (~100 times a second while music
plays). Only listens on localhost.
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pyaudiowpatch as pyaudio

PORT = 8765
FPS = 60          # how often bars are refreshed when no new audio arrives (so they can fall)
FFT_SIZE = 2048
NUM_BANDS = 32
KICK_SIZE = 512   # the kick detector only looks at the newest ~10 ms, so it reacts fast
HERE = os.path.dirname(os.path.abspath(__file__))
# Lopsided window: rises over the older 80% of samples, drops over the newest 20%.
# Recent sound counts most, so kicks and hi-hats show ~8 ms sooner than with a
# plain Hann window, while keeping the bass detail of a 2048-sample FFT.
_RISE = int(FFT_SIZE * 0.8)
WINDOW = np.concatenate([np.hanning(2 * _RISE)[:_RISE],
                         np.hanning(2 * (FFT_SIZE - _RISE))[FFT_SIZE - _RISE:]]).astype(np.float32)
KICK_WINDOW = np.hanning(KICK_SIZE).astype(np.float32)


class Capture:
    """Keeps the last FFT_SIZE samples of the default speaker's output."""

    def __init__(self):
        self.ring = np.zeros(FFT_SIZE, np.float32)
        self.last_data = 0.0
        self.last_analysis = time.monotonic()
        self.smooth = np.zeros(NUM_BANDS, np.float32)
        self.kick_avg = self.kick_prev = self.kick_loud = self.last_kick = 0.0
        self.kicks = 0  # beat counter; the page flashes whenever it goes up
        self.resumed = False
        self.pa = None
        self.stream = None
        self.device = None
        self.open()

    def open(self):
        """(Re)open the loopback of the current default speaker."""
        self.close()
        self.pa = pyaudio.PyAudio()
        dev = self.pa.get_default_wasapi_loopback()
        rate = int(dev["defaultSampleRate"])
        self.channels = dev["maxInputChannels"]
        # Small buffer = low delay. No callback: read() collects whatever has
        # arrived, which costs far less CPU than ~190 callbacks a second.
        self.stream = self.pa.open(
            format=pyaudio.paFloat32, channels=self.channels, rate=rate, input=True,
            input_device_index=dev["index"], frames_per_buffer=256)

        # Band edges as FFT bin indices, log-spaced from 40 Hz to 16 kHz.
        freqs = np.geomspace(40, 16000, NUM_BANDS + 1)
        self.edges = np.round(freqs / (rate / FFT_SIZE)).astype(int)
        centers = np.sqrt(freqs[:-1] * freqs[1:])
        # Music has less energy in the highs; tilt +3 dB/octave so bars look even.
        self.tilt = 3 * np.log2(centers / 1000)
        # Kick detector: energy around 45-150 Hz in the newest KICK_SIZE samples.
        hz = rate / KICK_SIZE
        self.kick_bins = slice(max(1, int(45 / hz)), int(150 / hz) + 1)

        if dev["name"] != self.device:
            print(f"Listening to: {dev['name']} ({rate} Hz)", flush=True)
        self.device = dev["name"]

    def close(self):
        if self.stream:
            self.stream.stop_stream()
            self.stream.close()
            self.stream = None
        if self.pa:
            self.pa.terminate()
            self.pa = None

    def silent_for(self):
        return time.monotonic() - self.last_data

    def read(self):
        """Take whatever audio has arrived (Windows delivers ~10 ms at a time). True if any."""
        available = self.stream.get_read_available()
        if not available:
            return False
        data = self.stream.read(available, exception_on_overflow=False)
        mono = np.frombuffer(data, np.float32).reshape(-1, self.channels).mean(axis=1)[-FFT_SIZE:]
        self.ring = np.concatenate((self.ring[len(mono):], mono))
        # When sound starts after a pause, Windows can deliver it in bursts with gaps.
        # The jump at the end of a gap isn't a kick, so the beat check skips that chunk.
        self.resumed = self.silent_for() > 0.05
        self.last_data = time.monotonic()
        return True

    def analyse(self):
        """32 band values 0-255 (instant rise, smooth fall) and the beat counter."""
        now = time.monotonic()
        if self.silent_for() > 0.15:  # Windows sends nothing when no sound plays
            self.ring[:] = 0
        mag = np.abs(np.fft.rfft(self.ring * WINDOW)) / (FFT_SIZE / 4)
        peaks = np.maximum.reduceat(mag[:self.edges[-1]], self.edges[:-1])
        db = 20 * np.log10(peaks + 1e-9) + self.tilt
        level = np.clip((db + 65) / 55, 0, 1)
        fall = 0.65 ** ((now - self.last_analysis) * 60)  # same fall speed however often this runs
        self.last_analysis = now
        self.smooth = np.where(level > self.smooth, level, self.smooth * fall + level * (1 - fall))
        self.smooth[self.smooth < 0.05] = 0  # ignore faint background noise so the page can idle

        # Beat: kick energy jumps well above its recent average, is still rising, and is
        # at least 30% of the recent loudest kick (ignores small bass bumps between kicks).
        kick_mag = np.abs(np.fft.rfft(self.ring[-KICK_SIZE:] * KICK_WINDOW))[self.kick_bins] / (KICK_SIZE / 4)
        kick = float((kick_mag ** 2).sum())
        self.kick_loud = max(kick, self.kick_loud * 0.995)
        if (not self.resumed and kick > self.kick_avg * 2 and kick > self.kick_prev * 1.2
                and kick > 2e-4 and kick > self.kick_loud * 0.3 and now - self.last_kick > 0.2):
            self.kicks += 1
            self.last_kick = now
        self.kick_avg += (kick - self.kick_avg) * 0.05
        self.kick_prev = kick
        self.resumed = False
        return (self.smooth * 255).astype(int), self.kicks


def spotify_song():
    """'Artist - Song' from the Spotify window title, or '' when paused/closed."""
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    titles = []

    def check(hwnd, _):
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in spotify_song.pids:
            spotify_song.pids[pid.value] = False
            handle = kernel32.OpenProcess(0x1000, False, pid.value)  # QUERY_LIMITED_INFORMATION
            if handle:
                buf, size = ctypes.create_unicode_buffer(260), wt.DWORD(260)
                if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    spotify_song.pids[pid.value] = buf.value.lower().endswith("spotify.exe")
                kernel32.CloseHandle(handle)
        if spotify_song.pids[pid.value]:
            buf = ctypes.create_unicode_buffer(256)
            if user32.GetWindowTextW(hwnd, buf, 256) and " - " in buf.value:
                titles.append(buf.value)
        return True

    if len(spotify_song.pids) > 2000:
        spotify_song.pids.clear()
    proc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)(check)
    user32.EnumWindows(proc, 0)
    return titles[0] if titles else ""


spotify_song.pids = {}


class Hub:
    """Analysis loop that runs only while a page is connected."""

    def __init__(self, capture, quit_when_idle=False):
        self.capture = capture
        self.quit_when_idle = quit_when_idle
        self.last_client = time.monotonic()
        self.cond = threading.Condition()
        self.msg, self.seq, self.clients = b"{}", 0, 0
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        song, next_song, last_frame, last_sent, next_check = "", 0.0, 0.0, 0.0, 0.0
        while True:
            time.sleep(0.004)  # check for new audio every 4 ms
            now = time.monotonic()
            if self.clients == 0:
                # App mode: the window has been closed for 20 s, so shut down.
                if self.quit_when_idle and now - self.last_client > 20:
                    print("Window closed, quitting.")
                    self.capture.close()
                    os._exit(0)
                continue
            self.last_client = now
            if now >= next_song:
                song, next_song = spotify_song(), now + 1

            # Analyse as soon as new audio arrives; without new audio, still refresh
            # 60 times a second so the bars can fall.
            if not self.capture.read() and now - last_frame < 1 / FPS:
                continue
            last_frame = now
            bands, kicks = self.capture.analyse()

            # No sound for a while: maybe the default speaker changed
            # (e.g. headphones plugged in), so reopen it. Re-checking costs ~0.3 s,
            # so do it 3 s into a silence and then every 20 s.
            if self.capture.silent_for() < 3:
                next_check = 0.0
            elif now >= next_check:
                self.capture.open()
                next_check = now + 20

            if not bands.any() and now - last_sent < 1:
                continue  # nothing to draw; just a heartbeat each second
            last_sent = now
            with self.cond:
                self.msg = json.dumps({"b": bands.tolist(), "k": kicks, "song": song}).encode()
                self.seq += 1
                self.cond.notify_all()

    def wait(self, seq):
        with self.cond:
            self.cond.wait_for(lambda: self.seq != seq, timeout=5)
            return self.seq, self.msg


class Handler(BaseHTTPRequestHandler):
    disable_nagle_algorithm = True  # send each small update right away, don't batch them
    files = {"/": ("stage.html", "text/html; charset=utf-8"),
             "/stage.html": ("stage.html", "text/html; charset=utf-8"),
             "/lightshow.js": ("lightshow.js", "text/javascript; charset=utf-8"),
             "/neon.ico": ("neon.ico", "image/x-icon")}

    def do_GET(self):
        if self.path == "/stream":
            return self.stream()
        if self.path not in self.files:
            return self.send_error(404)
        name, ctype = self.files[self.path]
        with open(os.path.join(HERE, name), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with hub.cond:
            hub.clients += 1
        seq = 0
        try:
            while True:
                seq, msg = hub.wait(seq)
                self.wfile.write(b"data: " + msg + b"\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with hub.cond:
                hub.clients -= 1

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    # Off on purpose: on Windows, address reuse lets a second copy share the port
    # instead of failing, so a second launch couldn't tell the app is already running.
    allow_reuse_address = False


def open_window(url):
    """Open the page as a plain app window (no tabs or address bar) in Edge or Chrome."""
    for path in (r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
                 r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
                 r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
                 r"%LocalAppData%\Google\Chrome\Application\chrome.exe"):
        path = os.path.expandvars(path)
        if os.path.exists(path):
            subprocess.Popen([path, f"--app={url}", "--window-size=1280,720"])
            return
    webbrowser.open(url)  # neither found: use the default browser


def main():
    """--app: started from the desktop shortcut (own window, no console, quits when closed).
    --open: open the page in the default browser. Neither: just run the server."""
    global hub
    app = "--app" in sys.argv
    url = f"http://127.0.0.1:{PORT}"
    try:
        server = Server(("127.0.0.1", PORT), Handler)
    except OSError:
        if app:  # already running: just open another window onto it
            return open_window(url)
        sys.exit(f"Port {PORT} is busy - is the visualizer already running? Open {url}")
    if app:  # pythonw has no console, so keep messages and errors in a log file
        sys.stdout = sys.stderr = open(os.path.join(HERE, "ears.log"), "w", buffering=1)
    hub = Hub(Capture(), quit_when_idle=app)
    print(f"Visualizer running at {url}  (Ctrl+C to stop)", flush=True)
    if app:
        open_window(url)
    elif "--open" in sys.argv:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
