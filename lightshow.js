// Draws the 32 bands streamed by ears.py with plain Canvas 2D.
// The effects are cheap on purpose:
//  - trails: each frame fades the last one a little instead of clearing it
//  - glow: a blurred 1/8-size copy of the canvas that CSS stretches back over it (see stage.html)
// Drawing is capped at 60 fps and stops completely while nothing is playing.

const $ = (id) => document.getElementById(id);
const canvas = $('c'), ctx = canvas.getContext('2d');
const glow = $('glow'), gctx = glow.getContext('2d');
const N = 32;
const MODES = ['Bars', 'Halo', 'Aurora', 'Warp'];
const MODE_GLOW = [1, 1, 0.5, 1]; // Aurora is mostly big bright areas, so it gets less glow
const TAU = Math.PI * 2;

const target = new Float32Array(N); // latest values from the server, 0-1
const cur = new Float32Array(N);    // copy of target taken at the start of each frame
const peaks = new Float32Array(N);  // slowly falling peak markers (Bars mode)
const particles = [];
const stars = Array.from({ length: 260 }, () => newStar(Math.random()));
let W = 0, H = 0, mode = 0, hue = 210, pulse = 0, spin = 0, phase = 0;
let bass = 0, energy = 0, kicks = null, lastSound = 0;
let running = false, lastFrame = 0, quietFrames = 0, connected = false, song = '', songTimer, cursorTimer;
let syncOffset = 40; // ms the beat effect fires early once the tempo is locked ([ and ] adjust)
let bgChanged = 0;
let statusNote = '', noteTimer;

try { mode = Math.min(+localStorage.getItem('mode') || 0, MODES.length - 1); } catch {}
try { syncOffset = +(localStorage.getItem('sync') ?? 40); } catch {}

// ---- data from the server ----

const events = new EventSource('/stream'); // reconnects by itself
events.onopen = () => setStatus(true);
events.onerror = () => setStatus(false);
events.onmessage = (e) => {
  const data = JSON.parse(e.data);
  for (let i = 0; i < N; i++) target[i] = data.b[i] / 255;
  if (data.b.some((v) => v > 0)) { lastSound = performance.now(); wake(); }
  // The server counts kick drums; react the moment the count goes up.
  if (kicks !== null && data.k > kicks) kickDetected(performance.now());
  kicks = data.k;
  if (data.song !== song) showSong(data.song);
};

function setStatus(on) {
  connected = on;
  $('dot').classList.toggle('on', on);
  $('statusText').textContent = (on ? 'Listening' : 'Waiting for server…') + ' · ' + MODES[mode] +
    (clock.period ? ' · beat locked' : '') + (statusNote ? ' · ' + statusNote : '');
}

// Show a short note (like the sync setting) in the status line for 2 s.
function note(text) {
  statusNote = text;
  setStatus(connected);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { statusNote = ''; setStatus(connected); }, 2000);
}

// ---- beat lock ----
// A detected kick reaches the screen a little late (audio capture + display).
// When kicks come at a steady tempo, the next one can be predicted, so the beat
// effect fires `syncOffset` ms early and lands right on the beat. Irregular rhythms
// fall back to reacting on detection.
const clock = { times: [], period: 0, next: 0, firedAt: -1e9, missed: 0, pending: 0 };

function kickDetected(now) {
  clock.pending = 0; // the kick we predicted did arrive
  clock.times.push(now);
  if (clock.times.length > 7) clock.times.shift();
  const gaps = clock.times.slice(1).map((t, i) => t - clock.times[i]);
  const median = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
  // Locked only when the last 4 gaps are within 6% of each other (a steady tempo).
  const steady = gaps.length >= 4 && gaps.slice(-4).every((g) => Math.abs(g - median) < median * 0.06);
  const wasLocked = clock.period > 0;
  clock.period = steady ? median : 0;
  clock.next = steady ? now + median : 0;
  clock.missed = 0;
  if (wasLocked !== steady) setStatus(connected);
  // The predicted effect already fired for this kick: don't fire twice.
  if (now - clock.firedAt > 150) onBeat();
}

function unlock() {
  clock.times = [];
  clock.period = clock.next = clock.pending = 0;
  setStatus(connected);
}

// Called every frame: fire the predicted beat when its moment comes.
function predictBeat(now) {
  if (!clock.next || now < clock.next - syncOffset - 8) return; // 8 ms = half a frame
  // The music stopped, or two predicted kicks in a row never arrived: stop predicting.
  if (energy < 0.05 || clock.missed >= 2) return unlock();
  // The last predicted kick never arrived: keep its expected time, so one missed
  // kick doesn't look like a change of tempo.
  if (clock.pending) clock.times.push(clock.pending);
  clock.pending = clock.next;
  clock.firedAt = now;
  onBeat();
  clock.next += clock.period;
  clock.missed++;
}

function showSong(name) {
  song = name;
  clearTimeout(songTimer);
  if (!name) { $('song').style.opacity = 0; return; }
  const [artist, ...rest] = name.split(' - ');
  $('artist').textContent = rest.length ? artist : '';
  $('title').textContent = rest.length ? rest.join(' - ') : name;
  $('song').style.opacity = 1;
  songTimer = setTimeout(() => { $('song').style.opacity = 0.4; }, 8000);
}

// ---- animation loop ----

function wake() {
  quietFrames = 0;
  if (!running) { running = true; lastFrame = performance.now(); requestAnimationFrame(frame); }
}

function frame(now) {
  if (now - lastFrame < 15) { requestAnimationFrame(frame); return; } // cap at ~60 fps
  const elapsed = (now - lastFrame) / 16.7; // 1 = one 60 fps frame
  const dt = Math.min(elapsed, 4);           // capped so motion never jumps too far
  lastFrame = now;

  // No extra smoothing here: the server already eases the fall, and any more
  // would make the picture lag behind the music.
  let total = 0;
  cur.set(target);
  for (let i = 0; i < N; i++) {
    peaks[i] = Math.max(cur[i], peaks[i] - 0.005 * dt);
    total += cur[i];
  }
  energy = total / N;
  bass = (cur[0] + cur[1] + cur[2] + cur[3]) / 4;
  pulse *= Math.pow(0.85, dt);
  predictBeat(now);

  // A few sparks twinkle between beats too, following the hi-hats and cymbals.
  const highs = (cur[24] + cur[26] + cur[28] + cur[30]) / 4;
  if (Math.random() < highs * 0.5 * dt) emit(1, 0.8);
  hue = (hue + 0.1 * dt) % 360;
  // The background follows the colour slowly: one small change every few seconds.
  if (now - bgChanged > 4000) {
    bgChanged = now;
    document.body.style.setProperty('--h', Math.round(hue));
  }
  spin += (0.001 + energy * 0.006) * dt;
  phase += 0.015 * dt;

  draw(dt, elapsed);

  // Silent for 2 s: keep drawing ~30 more frames so the trails fade out, then stop
  // until sound comes back.
  const silent = now - lastSound > 2000 && total < 0.01 && !particles.length;
  quietFrames = silent ? quietFrames + 1 : 0;
  if (quietFrames > 30) { running = false; return; }
  requestAnimationFrame(frame);
}

function onBeat() {
  pulse = 1;
  hue = (hue + 4) % 360; // a small nudge: colours drift with the music instead of jumping
  emit(45, 1.6);
}

// Sparks: where they start and how they fly depends on the mode (Warp has its stars instead).
function emit(count, power) {
  const base = H * 0.68, slot = W / (N * 2), r = Math.min(W, H) * 0.19;
  for (let k = 0; k < count; k++) {
    const speed = power * (1 + Math.random() * 2.5), a = Math.random() * TAU;
    if (mode === 0) {        // Bars: embers shoot up off the bar tops, then arc back down
      const i = Math.floor(Math.random() * N), side = Math.random() < 0.5 ? -1 : 1;
      spawn(W / 2 + side * (i + 0.5) * slot, base - 3 - cur[i] * H * 0.55,
        (Math.random() - 0.5) * 1.5, -speed * 1.4, 0.06);
    } else if (mode === 1) { // Halo: burst outward from the ring with a slight spiral
      spawn(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r,
        Math.cos(a + 0.35) * speed, Math.sin(a + 0.35) * speed, 0);
    } else if (mode === 2) { // Aurora: drift up and down out of the ribbons
      spawn(Math.random() * W, H / 2, Math.random() - 0.5, (Math.random() < 0.5 ? -1 : 1) * speed, 0);
    }
  }
}

function color(h, light = 60, alpha = 1) {
  return `hsla(${h % 360}, 90%, ${light}%, ${alpha})`;
}

// Band value at position t (0 = bass, 1 = highs), smoothly interpolated.
function sample(t) {
  const x = Math.max(0, Math.min(1, t)) * (N - 1), i = Math.floor(x), f = x - i;
  const a = cur[i], b = cur[Math.min(i + 1, N - 1)];
  return a + (b - a) * (1 - Math.cos(f * Math.PI)) / 2;
}

function draw(dt, elapsed = 1) {
  // Canvas at 1 CSS pixel per pixel: sharp enough and much cheaper on big screens.
  if (W !== innerWidth || H !== innerHeight) {
    W = canvas.width = innerWidth;
    H = canvas.height = innerHeight;
    glow.width = Math.ceil(W / 8);
    glow.height = Math.ceil(H / 8);
  }

  // Fade the previous frame toward transparent instead of clearing it: light trails.
  // Based on elapsed time, so a slow or throttled browser doesn't leave old images behind.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = `rgba(0, 0, 0, ${1 - Math.pow(0.55, elapsed)})`;
  ctx.fillRect(0, 0, W, H);

  // Everything below adds light, so overlaps glow brighter.
  ctx.globalCompositeOperation = 'lighter';
  const shake = pulse * 2.5;
  ctx.setTransform(1, 0, 0, 1, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  [drawBars, drawHalo, drawAurora, drawWarp][mode](dt);
  drawParticles(dt);

  // Beat flash: a soft, quick glow from the centre.
  if (pulse > 0.05) {
    const flash = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.5);
    flash.addColorStop(0, color(hue, 70, 0.07 * pulse));
    flash.addColorStop(1, color(hue, 50, 0));
    ctx.fillStyle = flash;
    ctx.fillRect(-10, -10, W + 20, H + 20);
  }

  // Glow layer: shrink the frame into the small canvas twice (doubles its brightness),
  // blurred while it's small, so the stretched glow is smooth instead of blocky.
  // Blurring a 1/8-size image is very cheap.
  gctx.filter = 'blur(2px)';
  gctx.globalCompositeOperation = 'source-over';
  gctx.clearRect(0, 0, glow.width, glow.height);
  gctx.drawImage(canvas, 0, 0, glow.width, glow.height);
  gctx.globalCompositeOperation = 'lighter';
  gctx.drawImage(canvas, 0, 0, glow.width, glow.height);
}

// Soft round glow (white-hot centre, coloured halo), drawn once per colour and reused:
// stamping a small ready-made image is much cheaper than drawing a gradient each time.
const sprites = new Map();
function sprite(h) {
  const key = (Math.round(h / 10) * 10) % 360;
  let s = sprites.get(key);
  if (!s) {
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const g = s.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.12, `hsla(${key}, 100%, 80%, 0.9)`);
    grad.addColorStop(0.4, `hsla(${key}, 100%, 60%, 0.25)`);
    grad.addColorStop(1, `hsla(${key}, 100%, 50%, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    sprites.set(key, s);
  }
  return s;
}

// ---- modes ----
// Shapes are collected into a few Path2D objects and drawn with one call per colour,
// which is much cheaper than one call per bar or star.

// Mirrored bars on a horizon with a faint reflection and falling peak markers.
function drawBars() {
  const base = H * 0.68, slot = W / (N * 2), bw = slot * 0.62, max = H * 0.55 * (1 + pulse * 0.1);
  const bars = new Path2D(), reflection = new Path2D(), caps = new Path2D();
  for (let i = 0; i < N; i++) {
    const bh = 3 + cur[i] * max, ph = peaks[i] * max;
    for (const x of [W / 2 + i * slot, W / 2 - (i + 1) * slot]) {
      const left = x + (slot - bw) / 2;
      bars.rect(left, base - bh, bw, bh);
      reflection.rect(left, base + 6, bw, bh * 0.45);
      caps.rect(left, base - ph - 7, bw, 2);
    }
  }
  const grad = ctx.createLinearGradient(0, base - max, 0, base);
  grad.addColorStop(0, color(hue + 90, 70));
  grad.addColorStop(1, color(hue, 50));
  ctx.fillStyle = grad;
  ctx.fill(bars);
  ctx.globalAlpha = 0.15;
  ctx.fill(reflection);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = color(hue + 90, 85);
  ctx.fill(caps);
  ctx.globalAlpha = 1;
}

// A slowly spinning ring of bars: bass at the top and bottom, highs at the sides.
// Bars are grouped into 8 loudness levels, each drawn in one colour.
function drawHalo() {
  const cx = W / 2, cy = H / 2, size = Math.min(W, H), count = 120, levels = 8;
  const r = size * (0.17 + bass * 0.05 + pulse * 0.02);
  const paths = Array.from({ length: levels }, () => new Path2D());
  for (let k = 0; k < count; k++) {
    const t = k / count, v = sample(1 - Math.abs(1 - 2 * ((t * 2) % 1)));
    const a = t * TAU + spin, cos = Math.cos(a), sin = Math.sin(a);
    const out = 4 + v * size * 0.27, inner = v * r * 0.35;
    const path = paths[Math.min(levels - 1, Math.floor(v * levels))];
    path.moveTo(cx + cos * (r - inner), cy + sin * (r - inner));
    path.lineTo(cx + cos * (r + out), cy + sin * (r + out));
  }
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(2, ((TAU * r) / count) * 0.5);
  paths.forEach((path, l) => {
    const v = (l + 0.5) / levels;
    ctx.strokeStyle = color(hue + v * 120, 55 + v * 15);
    ctx.stroke(path);
  });
  ctx.lineWidth = 2;
  ctx.strokeStyle = color(hue + 40, 80, 0.8);
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.62, 0, TAU);
  ctx.stroke();
}

// Three layered, rippling ribbons of light: bass in the middle, highs at the edges.
function drawAurora() {
  const steps = 72;
  ctx.lineWidth = 1.5;
  for (let layer = 0; layer < 3; layer++) {
    const mid = H * (0.5 + (layer - 1) * 0.05), amp = H * (0.34 - layer * 0.07) * (1 + pulse * 0.08);
    const h = hue + layer * 45, speed = 1 + layer * 0.6;
    const ys = [];
    for (let k = 0; k <= steps; k++) {
      // Start a few bands up: the deepest bass is often quiet and would pinch the middle.
      const t = k / steps, v = sample(0.1 + 0.9 * Math.abs(2 * t - 1));
      const ripple = 0.85 + 0.15 * Math.sin(t * 14 + phase * speed * 3);
      ys.push(v * ripple * amp + 2);
    }
    const ribbon = new Path2D();
    for (let k = 0; k <= steps; k++) ribbon.lineTo((k / steps) * W, mid - ys[k]);
    for (let k = steps; k >= 0; k--) ribbon.lineTo((k / steps) * W, mid + ys[k]);
    ribbon.closePath();
    ctx.fillStyle = color(h, 55, 0.12);
    ctx.fill(ribbon);
    ctx.strokeStyle = color(h + 30, 75, 0.55);
    ctx.stroke(ribbon);
  }
}

// Flying through stars: speed follows the music, beats give a burst.
// Each star belongs to one of 8 groups that shares a colour and follows one part of the spectrum.
function newStar(z = 1) {
  return { x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z, group: Math.floor(Math.random() * 8) };
}

function drawWarp(dt) {
  const cx = W / 2, cy = H / 2, size = Math.min(W, H), f = size * 0.6;
  const speed = (0.002 + energy * 0.012 + pulse * 0.02) * dt;

  // White-hot core that swells with the bass.
  const r = size * (0.08 + bass * 0.09 + pulse * 0.04);
  ctx.globalAlpha = 0.55 + pulse * 0.45;
  ctx.drawImage(sprite(hue), cx - r, cy - r, r * 2, r * 2);
  ctx.globalAlpha = 1;

  // Streaks, grouped by colour; nearby stars also get a glowing head.
  const paths = Array.from({ length: 8 }, () => new Path2D());
  for (let i = 0; i < stars.length; i++) {
    const s = stars[i], z0 = s.z;
    s.z -= speed;
    if (s.z <= 0.02) { stars[i] = newStar(); continue; }
    const x = cx + (s.x / s.z) * f, y = cy + (s.y / s.z) * f;
    paths[s.group].moveTo(cx + (s.x / z0) * f, cy + (s.y / z0) * f);
    paths[s.group].lineTo(x, y);
    if (s.z < 0.6) {
      const near = 1 - s.z / 0.6, v = cur[s.group * 4 + 1];
      const d = (4 + 18 * near) * (0.7 + v * 0.6);
      ctx.globalAlpha = near;
      ctx.drawImage(sprite(hue + s.group * 15), x - d / 2, y - d / 2, d, d);
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  paths.forEach((path, g) => {
    const v = cur[g * 4 + 1];
    ctx.strokeStyle = color(hue + g * 15, 55 + v * 30, 0.5 + v * 0.5);
    ctx.lineWidth = 1.2 + v * 2.5;
    ctx.stroke(path);
  });
}

// ---- particles (sparks) ----

function spawn(x, y, vx, vy, gravity) {
  if (particles.length >= 300) return;
  particles.push({
    x, y, vx, vy, gravity, life: 1,
    fade: 0.008 + Math.random() * 0.01,  // lives about 1-2 s
    size: 0.6 + Math.random() * 0.8,
    tint: Math.random() * 60,
    twinkle: Math.random() * TAU,
  });
}

// Each spark is a glowing head (a stamped sprite) with a comet tail.
// Tails are grouped into 3 brightness levels, one draw call each.
function drawParticles(dt) {
  const tails = [new Path2D(), new Path2D(), new Path2D()];
  const drag = Math.pow(0.965, dt);
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.gravity * dt;
    p.vx *= drag;
    p.vy *= drag;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= p.fade * dt;
    if (p.life <= 0) { particles[i] = particles[particles.length - 1]; particles.pop(); continue; }

    const tail = tails[Math.min(2, Math.floor(p.life * 3))];
    tail.moveTo(p.x - p.vx * 5, p.y - p.vy * 5);
    tail.lineTo(p.x, p.y);

    const twinkle = 0.8 + 0.2 * Math.sin(p.twinkle + p.life * 50);
    const s = (8 + 16 * p.size) * (0.35 + 0.65 * p.life) * twinkle;
    ctx.globalAlpha = Math.min(1, p.life * 1.6);
    ctx.drawImage(sprite(hue + p.tint), p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.lineCap = 'round';
  tails.forEach((path, l) => {
    ctx.strokeStyle = color(hue + 30, 75, 0.2 + l * 0.2);
    ctx.lineWidth = 1 + l * 0.7;
    ctx.stroke(path);
  });
}

// ---- controls ----

function setMode(m) {
  mode = m;
  particles.length = 0; // sparks belong to the mode that made them
  glow.style.opacity = MODE_GLOW[m];
  try { localStorage.setItem('mode', m); } catch {}
  setStatus(connected);
  wake();
}

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (['1', '2', '3', '4'].includes(k)) setMode(+k - 1);
  else if (k === ' ') setMode((mode + 1) % MODES.length);
  else if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  else if (k === 'h') $('ui').classList.toggle('hidden');
  else if (k === '[' || k === ']') { // fine-tune sync: ] = beat effect earlier, [ = later
    syncOffset = Math.max(0, Math.min(200, syncOffset + (k === ']' ? 10 : -10)));
    try { localStorage.setItem('sync', syncOffset); } catch {}
    note(`beat ${syncOffset} ms early`);
  }
});

// Hide the mouse pointer after 2 s without movement.
addEventListener('mousemove', () => {
  document.body.style.cursor = '';
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => { document.body.style.cursor = 'none'; }, 2000);
});

addEventListener('resize', wake);
glow.style.opacity = MODE_GLOW[mode];
setStatus(false);
wake();
