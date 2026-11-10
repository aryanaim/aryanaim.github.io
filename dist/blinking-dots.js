/*
 * Blinking dots -- a crisp field of dots blinking in and out on a fixed grid,
 * used as the background of the paper pages.
 *
 * This is NOT React Bits Pro's component. That one is licensed, the registry
 * needs an Authorization header this project has no key for, and it ships as a
 * React/shadcn package that a four-file static site cannot consume anyway. So
 * this is an independent vanilla-canvas implementation, written to the same
 * effect and using the published prop names (density, coverage, jitter,
 * dotSize, sizeVariation, layers, twinkle, driftSpeed, cursorParallax,
 * colorFrom/To, backgroundColor, adaptiveQuality, paused) so the knobs read the
 * same. cellSize, blinkSpeed, opacity and fps are additions.
 *
 * It upgrades the static `.grid-bg` texture rather than layering over it: the
 * canvas mounts inside that element, inherits its placement and its radial
 * mask, and the CSS dot-grid steps aside once the canvas has painted. With no
 * canvas, no JS, or reduced motion, the static grid simply stays.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  /* Tuned for these pages, whose `.grid-bg` already lays 1px white dots on a
     28px pitch: the field keeps that pitch and palette and stays close to the
     grid rather than scattering, so it reads as the existing texture coming
     alive. React Bits' published defaults are in the trailing comments; every
     one of these is overridable per element with data-dots-* (kebab-case, so
     data-dots-cursor-parallax="0.1"). */
  const DEFAULTS = {
    density: 20, //          grid cells along the shortest side, when cellSize is unset
    cellSize: 28, //         published: n/a -- addition, matches .grid-bg's pitch exactly
    coverage: 0.85, //       published 0.8   -- fraction of cells holding a dot
    jitter: 0.15, //         published 0.6   -- low, or the grid stops reading as a grid
    dotSize: 1, //           radius multiplier
    sizeVariation: 1, //     spread between the smallest and largest dots
    layers: 1, //            published 2     -- one crisp grid here, not a starfield
    twinkle: 0.25, //        published 0.4   -- brightness flicker on top of the blink
    blinkSpeed: 0.28, //     published: n/a -- addition, blink cycles/sec before variation
    driftSpeed: 0.004, //    published 0.012 -- a near-static field, as "fixed grid" implies
    cursorParallax: 0.02, // published 0.06  -- just enough to feel attached to the cursor
    colorFrom: 'var(--ink-dim)', //  published #cc0080 -- hot pink; this site is monochrome
    colorTo: 'var(--ink)', //        published #ffccff
    backgroundColor: 'transparent', // published #0a0a0a; transparent keeps the page vignette
    // Set so the field's average presence lands on .grid-bg's constant 0.14:
    // the blink duty and the twinkle both pull the mean well below this peak.
    opacity: 0.5,
    // The blink cycles over seconds and the parallax is 0.02, so there is
    // nothing here that needs 60fps. Halving the redraws halves the cost of a
    // background that has to stay out of the way of Lenis' smooth scrolling.
    fps: 30,
    adaptiveQuality: true,
    paused: false
  };

  /* ── config ── */

  const readConfig = (el) => {
    const cfg = {};
    Object.keys(DEFAULTS).forEach((key) => {
      // data-dots-color-from -> dataset.dotsColorFrom
      const raw = el.dataset['dots' + key.charAt(0).toUpperCase() + key.slice(1)];
      const dflt = DEFAULTS[key];
      if (raw === undefined) {
        cfg[key] = dflt;
      } else if (typeof dflt === 'number') {
        const n = parseFloat(raw);
        cfg[key] = Number.isFinite(n) ? n : dflt;
      } else if (typeof dflt === 'boolean') {
        cfg[key] = raw !== 'false';
      } else {
        cfg[key] = raw;
      }
    });
    cfg.layers = Math.max(1, Math.min(4, Math.round(cfg.layers)));
    return cfg;
  };

  // Lets colours be given as design tokens -- data-dots-color-to="var(--ink)"
  // keeps the field on the palette instead of hard-coding it here.
  const resolveColor = (value, el) => {
    const token = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(String(value).trim());
    if (!token) return value;
    const read = window.getComputedStyle(el).getPropertyValue(token[1]).trim();
    return read || token[2] || '#ffffff';
  };

  // Parse to [r,g,b,a] via the browser, so any CSS colour syntax works.
  const parseColor = (value) => {
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = '#000';
    probe.fillStyle = value;
    const out = probe.fillStyle;
    if (out.charAt(0) === '#') {
      const hex = out.length === 4
        ? out.slice(1).split('').map((c) => c + c).join('')
        : out.slice(1);
      const n = parseInt(hex, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
    }
    const parts = out.replace(/rgba?\(|\)|\s/g, '').split(',').map(Number);
    return [parts[0] || 0, parts[1] || 0, parts[2] || 0, parts.length > 3 ? parts[3] : 1];
  };

  /* ── deterministic per-cell randomness ──
     The grid is conceptually infinite: a cell's dot is derived from its
     absolute index, so the field pans forever without dots popping or the
     pattern tiling. One 32-bit hash is sliced into several values rather than
     hashed repeatedly, which is cheap enough to redo every frame -- and redoing
     it is what keeps the grid fixed while the field moves over it. */

  const hash = (x, y, z) => {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1442695040;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  };

  const slice = (h, shift, bits) => {
    const mask = (1 << bits) - 1;
    return ((h >>> shift) & mask) / mask;
  };

  // sin by table, indexed in turns rather than radians: two of these run per
  // dot per frame, and negative indices wrap correctly under a bitwise &.
  const SIN_BITS = 11;
  const SIN_N = 1 << SIN_BITS;
  const SIN = new Float32Array(SIN_N);
  for (let i = 0; i < SIN_N; i++) SIN[i] = Math.sin((i / SIN_N) * TAU);
  const sinTurns = (turns) => SIN[((turns * SIN_N) | 0) & (SIN_N - 1)];

  const ALPHA_STEPS = 20; // dots are quantised onto pre-rendered sprites...
  const SIZE_STEPS = 4; //  ...so drawing one costs a blit and no state change

  /* ── instance ── */

  const mount = (host) => {
    const cfg = readConfig(host);
    const from = parseColor(resolveColor(cfg.colorFrom, host));
    const to = parseColor(resolveColor(cfg.colorTo, host));
    const background = String(cfg.backgroundColor).trim();
    const opaqueBg = background && background !== 'transparent' && background !== 'none';

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d', { alpha: !opaqueBg });
    if (!ctx) return null;
    host.appendChild(canvas);

    const atlas = document.createElement('canvas');
    const actx = atlas.getContext('2d');
    if (!actx) return null;

    const ticker = window.gsap ? window.gsap.ticker : null;
    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5 };
    const start = performance.now();

    const radiusBuckets = cfg.layers * SIZE_STEPS;
    const depthOf = (layer) => (cfg.layers === 1 ? 1 : 1 - (layer / (cfg.layers - 1)) * 0.55);

    let width = 0;
    let height = 0;
    let cell = 24;
    let baseRadius = 1;
    let maxRadius = 2;
    let sprite = 8; // sprite box, device px
    let scale = 1; // adaptiveQuality render scale
    let dpr = 1;
    let running = false;
    let rafId = 0;
    let disposed = false;
    let revealed = false;
    let lastTime = 0;
    let lastDraw = 0;
    let frameAvg = 16;
    let goodFrames = 0;
    let badFrames = 0;

    const renderDpr = () => Math.min(window.devicePixelRatio || 1, 2) * scale;

    const radiusFor = (bucket) => {
      const layer = (bucket / SIZE_STEPS) | 0;
      const t = ((bucket % SIZE_STEPS) + 0.5) / SIZE_STEPS;
      return baseRadius * (0.6 + 0.4 * depthOf(layer)) * (1 + cfg.sizeVariation * (t - 0.5));
    };

    // One sprite per (radius bucket, alpha bucket). Blitting these beats
    // pathing an arc per dot by roughly an order of magnitude, and bakes the
    // alpha in so the whole field draws without touching context state.
    const buildAtlas = () => {
      sprite = Math.max(2, Math.ceil((maxRadius + 1) * 2 * dpr));
      if (sprite % 2) sprite++;
      atlas.width = sprite * ALPHA_STEPS;
      atlas.height = sprite * Math.max(1, radiusBuckets);
      actx.setTransform(1, 0, 0, 1, 0, 0);
      actx.clearRect(0, 0, atlas.width, atlas.height);
      for (let b = 0; b < radiusBuckets; b++) {
        const t = ((b % SIZE_STEPS) + 0.5) / SIZE_STEPS;
        const cr = Math.round(from[0] + (to[0] - from[0]) * t);
        const cg = Math.round(from[1] + (to[1] - from[1]) * t);
        const cb = Math.round(from[2] + (to[2] - from[2]) * t);
        const ca = from[3] + (to[3] - from[3]) * t;
        const r = Math.max(0.35, radiusFor(b) * dpr);
        for (let k = 0; k < ALPHA_STEPS; k++) {
          const a = ((k + 0.5) / ALPHA_STEPS) * ca;
          actx.fillStyle = `rgba(${cr},${cg},${cb},${a.toFixed(4)})`;
          actx.beginPath();
          actx.arc(k * sprite + sprite / 2, b * sprite + sprite / 2, r, 0, TAU);
          actx.fill();
        }
      }
    };

    const resize = () => {
      if (disposed) return;
      const rect = host.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      dpr = renderDpr();
      const bw = Math.max(1, Math.round(width * dpr));
      const bh = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      cell = cfg.cellSize > 0 ? cfg.cellSize : Math.min(width, height) / Math.max(cfg.density, 1);
      cell = Math.max(4, cell);
      // ~1px dots at the site's pitch, nudged up a little on coarser grids so a
      // sparse field doesn't disappear
      baseRadius = Math.max(0.5, cfg.dotSize * Math.min(1.6, cell / 24));
      maxRadius = baseRadius * (1 + cfg.sizeVariation);
      buildAtlas();
    };

    const draw = (elapsed) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (opaqueBg) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }

      const shortest = Math.min(width, height);
      const px = (pointer.x - 0.5) * 2;
      const py = (pointer.y - 0.5) * 2;
      const half = sprite / 2;
      const twTurns = elapsed * 0.7;

      for (let layer = 0; layer < cfg.layers; layer++) {
        // 0 is the nearest layer: largest, brightest, most parallax
        const depth = depthOf(layer);
        const layerAlpha = (0.45 + 0.55 * depth) * cfg.opacity;
        const drift = elapsed * cfg.driftSpeed * shortest * depth;
        const par = cfg.cursorParallax * shortest * depth;
        const offX = drift * 0.85 - px * par;
        const offY = -drift * 0.55 - py * par;
        const bucketBase = layer * SIZE_STEPS;

        // widest excursion a dot can make from its cell centre
        const pad = cell * (0.5 + cfg.jitter * 0.5) + maxRadius + 2;
        const i0 = Math.floor((-offX - pad) / cell);
        const i1 = Math.ceil((width - offX + pad) / cell);
        const j0 = Math.floor((-offY - pad) / cell);
        const j1 = Math.ceil((height - offY + pad) / cell);

        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const h1 = hash(i, j, layer);
            if (slice(h1, 0, 8) >= cfg.coverage) continue;

            const h2 = hash(i, j, layer + 64);

            // blink: a smooth hump across `duty` of the cycle, dark for the rest
            const rate = 0.55 + slice(h2, 6, 6) * 0.9;
            const duty = 0.35 + slice(h2, 0, 6) * 0.5;
            let p = elapsed * cfg.blinkSpeed * rate + slice(h1, 26, 6);
            p -= Math.floor(p);
            if (p >= duty) continue;
            let a = sinTurns(0.5 * (p / duty));
            a *= a * (2 - a); // sharpen the ends so it reads as blinking, not breathing

            if (cfg.twinkle > 0) {
              a *= 1 - cfg.twinkle * (0.5 + 0.5 * sinTurns(twTurns + slice(h2, 12, 6)));
            }
            a *= layerAlpha;
            if (a <= 0.006) continue;

            const x = offX + (i + 0.5) * cell + (slice(h1, 8, 6) - 0.5) * cfg.jitter * cell;
            const y = offY + (j + 0.5) * cell + (slice(h1, 14, 6) - 0.5) * cfg.jitter * cell;

            const bucket = bucketBase + Math.min(SIZE_STEPS - 1, (slice(h1, 20, 6) * SIZE_STEPS) | 0);
            const k = a >= 1 ? ALPHA_STEPS - 1 : (a * ALPHA_STEPS) | 0;
            // snapped to whole device pixels, which is what keeps 1px dots crisp
            ctx.drawImage(
              atlas,
              k * sprite, bucket * sprite, sprite, sprite,
              ((x * dpr) | 0) - half, ((y * dpr) | 0) - half, sprite, sprite
            );
          }
        }
      }
    };

    // Drop resolution if frames get expensive, and climb back once they are
    // consistently cheap again. Both directions react slowly so it cannot
    // oscillate between the two.
    const adapt = (frameMs) => {
      if (!cfg.adaptiveQuality) return;
      frameAvg += (frameMs - frameAvg) * 0.1;
      if (frameAvg > 6 && scale > 0.55) {
        if (++badFrames > 40) {
          badFrames = goodFrames = 0;
          scale = Math.max(0.55, scale - 0.25);
          resize();
        }
      } else if (frameAvg < 2.5 && scale < 1) {
        if (++goodFrames > 200) {
          badFrames = goodFrames = 0;
          scale = Math.min(1, scale + 0.25);
          resize();
        }
      } else {
        badFrames = goodFrames = 0;
      }
    };

    const update = () => {
      if (disposed) return;
      const now = performance.now();
      const frameMs = lastTime ? now - lastTime : 16;
      lastTime = now;

      const dt = Math.min(frameMs * 0.001, 0.05);
      const follow = 1 - Math.exp(-3.5 * dt);
      pointer.x += (pointer.tx - pointer.x) * follow;
      pointer.y += (pointer.ty - pointer.y) * follow;

      // hold to the configured rate rather than the display's
      const interval = cfg.fps > 0 ? 1000 / cfg.fps : 0;
      if (interval && lastDraw && now - lastDraw < interval - 1) return;
      lastDraw = now;

      draw((now - start) * 0.001);
      adapt(performance.now() - now);
    };

    const tick = () => {
      if (!running) return;
      update();
      rafId = requestAnimationFrame(tick);
    };

    const startLoop = () => {
      if (running || disposed || cfg.paused) return;
      running = true;
      lastTime = 0;
      if (ticker) ticker.add(update);
      else rafId = requestAnimationFrame(tick);
    };

    const stopLoop = () => {
      if (!running) return;
      running = false;
      if (ticker) ticker.remove(update);
      else if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    // hand over from the CSS dot grid only once there is a painted frame to
    // hand over to
    const reveal = () => {
      if (revealed || disposed) return;
      revealed = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!disposed) host.classList.add('dots-live');
        });
      });
    };

    const onPointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      pointer.tx = event.clientX / Math.max(window.innerWidth, 1);
      pointer.ty = event.clientY / Math.max(window.innerHeight, 1);
    };

    // resize() reallocates the backing store and rebuilds the sprite atlas.
    // Chrome for Android fires resize on every address-bar collapse during a
    // scroll, so coalesce bursts into a single frame.
    let resizePending = 0;
    const onResize = () => {
      if (resizePending) return;
      resizePending = requestAnimationFrame(() => {
        resizePending = 0;
        resize();
        lastDraw = 0;
        draw((performance.now() - start) * 0.001);
      });
    };

    resize();
    draw(0);
    reveal();
    startLoop();

    window.addEventListener('resize', onResize);
    window.addEventListener('pointermove', onPointerMove, { passive: true });

    return {
      dispose() {
        if (disposed) return;
        disposed = true;
        stopLoop();
        if (resizePending) cancelAnimationFrame(resizePending);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('pointermove', onPointerMove);
        host.classList.remove('dots-live');
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  };

  /* ── wiring ── */

  const hosts = Array.prototype.slice.call(document.querySelectorAll('.grid-bg'));
  if (!hosts.length || window.__NO_GPU) return;

  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const instances = [];

  const apply = () => {
    if (reduceMotion && reduceMotion.matches) {
      // leave the static CSS grid alone: a field of dots blinking in and out is
      // precisely what reduced motion is asking us not to do
      while (instances.length) instances.pop().dispose();
      return;
    }
    if (instances.length) return;
    hosts.forEach((host) => {
      const instance = mount(host);
      if (instance) instances.push(instance);
    });
  };

  if (reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', apply);
  // wait for the page transition into this page to finish (see __arrived in
  // the project pages' <head>): the field's mount and fade-in would otherwise
  // run underneath it
  (window.__arrived || Promise.resolve()).then(apply);
})();
