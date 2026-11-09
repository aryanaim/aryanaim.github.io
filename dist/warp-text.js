/*
 * Glass-warp headline -- a dependency-free port of React Bits' <WarpText />
 * (https://reactbits.dev) for this static, no-build site.
 *
 * Two deliberate departures from upstream:
 *
 * 1. Upstream rasterises its own `text` prop and centres it in the box, which
 *    would mean throwing the real <h1> away. This headline can't be thrown
 *    away -- it carries the masked line-reveal intro, the italic run, and the
 *    heading semantics. So instead of re-typesetting the text, this version
 *    *traces* it: every glyph is drawn into the texture at the exact position,
 *    font, colour and text-shadow the browser already laid it out with. The
 *    WebGL copy is then swapped in for exactly as long as something is hovering
 *    the headline -- at rest the real DOM text is what you see, and it stays in
 *    the DOM throughout for screen readers, search engines and selection.
 *
 * 2. ogl is replaced by the ~80 lines of raw WebGL2 it would have wrapped
 *    (one fullscreen triangle, one program, one texture). Pulling a renderer
 *    in for that is a poor trade on a site with no bundler. The shaders below
 *    are upstream's, unchanged.
 */
(function () {
  'use strict';

  const VERTEX = `#version 300 es
in vec2 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

  const FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uTextTexture;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uPointerActive;
uniform float uTime;
uniform float uWarpStrength;
uniform float uWarpScale;
uniform float uSpeed;
uniform float uPointerInfluence;
uniform float uPointerStrength;
uniform float uRefraction;
uniform float uRipple;
uniform float uMotion;

in vec2 vUv;
out vec4 fragColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);

  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amplitude * noise(p);
    p *= 2.02;
    amplitude *= 0.5;
  }
  return value;
}

vec4 sampleText(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    return vec4(0.0);
  }
  return texture(uTextTexture, uv);
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float time = uTime * uSpeed;
  float scale = max(uWarpScale, 0.001);

  vec2 drift = vec2(time * 0.055, -time * 0.045);
  float n1 = fbm(uv * scale * 3.1 + drift);
  float n2 = fbm((uv + 19.17) * scale * 3.4 - drift.yx);
  vec2 ambient = (vec2(n1, n2) - 0.5) * uWarpStrength * 0.045 * uMotion;

  vec2 pointerDelta = uv - uPointer;
  vec2 aspectDelta = vec2(pointerDelta.x * aspect, pointerDelta.y);
  float dist = length(aspectDelta);
  float radius = max(uPointerInfluence, 0.001);
  float t = clamp(dist / radius, 0.0, 1.0);
  float lens = smoothstep(radius, 0.0, dist) * uPointerActive;
  float bulge = t * (1.0 - t) * (1.0 - t) * 6.75 * uPointerActive;
  vec2 dir = dist > 0.0001 ? vec2(aspectDelta.x / aspect, aspectDelta.y) / dist : vec2(0.0);

  float rippleWave = sin(dist * 28.0 - time * 4.2) * 0.5 + 0.5;
  float rippleRing = (rippleWave - 0.5) * uRipple;
  vec2 pointerWarp = -dir * bulge * uPointerStrength * 0.045;
  pointerWarp += dir * rippleRing * bulge * uPointerStrength * 0.016;

  vec2 displaced = uv + ambient + pointerWarp;
  vec2 splitDir = ambient + pointerWarp;
  float splitLen = length(splitDir);
  splitDir = splitLen > 0.00001 ? splitDir / splitLen : vec2(0.7071, 0.7071);
  vec2 split = splitDir * uRefraction * 0.16 * (0.35 + lens * 1.65);

  vec4 base = sampleText(displaced);
  float r = sampleText(displaced + split).r;
  float g = base.g;
  float b = sampleText(displaced - split).b;
  float a = max(max(sampleText(displaced + split).a, base.a), sampleText(displaced - split).a);

  vec3 color = vec3(r, g, b) + lens * base.a * 0.055;
  fragColor = vec4(color, a);
}
`;

  /* upstream's defaults; each is overridable per element with a data-attribute
     (data-warp-strength, data-warp-pointer-strength, ...) */
  const DEFAULTS = {
    warpStrength: 0.28, //     upstream 0.08 -- 2px of drift on this headline, near invisible
    warpScale: 1.15, //        upstream 1.7  -- fewer, broader cells: liquid, not frosted
    // Upstream's 0.55 leaves the flow all but frozen here. The shader drifts the
    // noise field by `speed * 0.055` uv/s against cells `1/(warpScale * 3.1)`
    // wide, so at 0.55 the field crosses ~7% of a cell per second -- an
    // undulation nobody can see. 1.35 puts it near a quarter-cell per second,
    // which is where it starts to read as moving liquid.
    speed: 1.35,
    pointerInfluence: 0.52, // upstream 0.42 -- a broad lens pulls more of the line with it
    pointerStrength: 0.46, //  upstream 0.38
    // Has to stay under a stroke width or the channels separate into three
    // legible ghosts instead of tinting an edge: the split peaks at
    // `refraction * 0.16 * 2` uv, and these strokes are ~6px on a ~1500px
    // canvas, so anything past ~0.012 stops looking like glass.
    refraction: 0.01,
    ripple: true
  };

  /* How the lens moves, as opposed to what it looks like. Rates are per second,
     fed through exponential smoothing (see `update`).

     The whole effect is gated on hovering the headline: `pointer.active` runs
     0 -> 1 on enter and back on leave, and everything -- lens, ambient flow and
     refraction -- is scaled by it. At 0 the shader's displacement and channel
     split are both exactly zero, so the render is the crisp trace pixel for
     pixel and the headline just looks like type until you touch it. */
  const MOTION = {
    pointerFollow: 6.0, // how hard the lens chases the cursor -- lower trails more
    lensRise: 5.0, //     ripple blooms in under the cursor...
    lensFall: 2.6 //      ...and lets go more slowly than it arrived
  };

  const readConfig = (el) => {
    const num = (key, fallback) => {
      const value = parseFloat(el.dataset[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      warpStrength: num('warpStrength', DEFAULTS.warpStrength),
      warpScale: num('warpScale', DEFAULTS.warpScale),
      speed: num('warpSpeed', DEFAULTS.speed),
      pointerInfluence: num('warpPointerInfluence', DEFAULTS.pointerInfluence),
      pointerStrength: num('warpPointerStrength', DEFAULTS.pointerStrength),
      refraction: num('warpRefraction', DEFAULTS.refraction),
      ripple: el.dataset.warpRipple === undefined ? DEFAULTS.ripple : el.dataset.warpRipple !== 'false'
    };
  };

  const renderDpr = () => Math.min(window.devicePixelRatio || 1, 2);

  /* ── tracing the live text into a 2D canvas ── */

  // computed text-shadow arrives as "<color> <x> <y> <blur>", comma separated,
  // and the commas inside rgba() have to survive the split.
  const splitShadows = (value) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < value.length; i++) {
      const char = value[i];
      if (char === '(') depth++;
      else if (char === ')') depth--;
      else if (char === ',' && depth === 0) {
        parts.push(value.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(value.slice(start));
    return parts;
  };

  const parseShadows = (value) => {
    if (!value || value === 'none') return [];
    return splitShadows(value)
      .map((part) => {
        const color = (part.trim().match(/^(rgba?\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)/i) || [])[0];
        const lengths = part.replace(/rgba?\([^)]*\)/i, '').match(/-?[\d.]+px/g) || [];
        if (!color || lengths.length < 2) return null;
        return {
          color,
          offsetX: parseFloat(lengths[0]),
          offsetY: parseFloat(lengths[1]),
          blur: lengths.length > 2 ? parseFloat(lengths[2]) : 0
        };
      })
      .filter(Boolean);
  };

  const metricsCache = new Map();
  const fontMetrics = (ctx, font, fontSize) => {
    let metrics = metricsCache.get(font);
    if (!metrics) {
      ctx.font = font;
      const measured = ctx.measureText('Hxg');
      const ascent = measured.fontBoundingBoxAscent;
      const descent = measured.fontBoundingBoxDescent;
      metrics = Number.isFinite(ascent) && Number.isFinite(descent)
        ? { ascent, descent }
        : { ascent: fontSize * 0.8, descent: fontSize * 0.2 };
      metricsCache.set(font, metrics);
    }
    return metrics;
  };

  /* The clip a glyph inherits from its ancestors, resolved once per element and
     memoised for the trace: `.word-line` masks the intro's slide with
     overflow:hidden, and a trace taken mid-reveal has to clip the same way or
     the lines would show un-masked, sliding up from below instead of rising out
     of nothing. */
  const makeClipResolver = (root, origin) => {
    const cache = new Map();
    const resolve = (el) => {
      if (!el || el === root) return null;
      if (cache.has(el)) return cache.get(el);

      let clip = resolve(el.parentElement);
      const computed = window.getComputedStyle(el);
      if (computed.overflow !== 'visible' || computed.overflowX !== 'visible' || computed.overflowY !== 'visible') {
        const r = el.getBoundingClientRect();
        const box = { l: r.left - origin.left, t: r.top - origin.top, r: r.right - origin.left, b: r.bottom - origin.top };
        clip = clip
          ? {
              l: Math.max(clip.l, box.l),
              t: Math.max(clip.t, box.t),
              r: Math.min(clip.r, box.r),
              b: Math.min(clip.b, box.b)
            }
          : box;
      }

      cache.set(el, clip);
      return clip;
    };
    return resolve;
  };

  // One entry per glyph, positioned from the browser's own layout, so kerning,
  // the -0.035em tracking, the word-spacing and any line wrapping all come out
  // exactly where the DOM put them -- no re-typesetting to drift out of sync.
  const collectGlyphs = (root, origin, ctx, quick) => {
    const glyphs = [];
    const styles = new Map();
    const clipFor = makeClipResolver(root, origin);
    const range = document.createRange();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.nodeValue && node.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent) continue;

      let style = styles.get(parent);
      if (!style) {
        const computed = window.getComputedStyle(parent);
        const fontSize = parseFloat(computed.fontSize) || 16;
        style = {
          hidden: computed.visibility === 'hidden' || computed.display === 'none',
          font: `${computed.fontStyle} ${computed.fontWeight} ${fontSize}px ${computed.fontFamily}`,
          fontSize,
          color: computed.color,
          shadows: quick ? EMPTY : parseShadows(computed.textShadow),
          clip: clipFor(parent)
        };
        styles.set(parent, style);
      }
      if (style.hidden) continue;

      const metrics = fontMetrics(ctx, style.font, style.fontSize);
      let offset = 0;
      for (const char of node.nodeValue) {
        const start = offset;
        offset += char.length;
        if (!char.trim()) continue;

        range.setStart(node, start);
        range.setEnd(node, offset);
        const rect = range.getBoundingClientRect();
        if (!rect.width && !rect.height) continue;

        glyphs.push({
          char,
          style,
          x: rect.left - origin.left,
          // CSS drops the baseline half a leading below the top of the inline
          // box; when a browser hands back a tight font box instead, that
          // leading term works out to zero, so one expression covers both.
          y:
            rect.top -
            origin.top +
            (rect.height - (metrics.ascent + metrics.descent)) / 2 +
            metrics.ascent
        });
      }
    }
    return glyphs;
  };

  // fillText with a shadow paints the glyph too, so the glyph is parked far off
  // canvas and the shadow offset brings only the shadow back into frame.
  const OFF_CANVAS = 10000;
  const EMPTY = [];

  const drawGlyphs = (ctx, glyphs, quick) => {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // glyphs arrive in DOM order, so runs sharing a clip are already adjacent
    let clip;
    let clipped = false;
    for (const glyph of glyphs) {
      if (glyph.style.clip !== clip) {
        if (clipped) {
          ctx.restore();
          clipped = false;
        }
        clip = glyph.style.clip;
        if (clip && clip.r > clip.l && clip.b > clip.t) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(clip.l, clip.t, clip.r - clip.l, clip.b - clip.t);
          ctx.clip();
          clipped = true;
        }
      }
      ctx.font = glyph.style.font;
      const shadows = quick ? EMPTY : glyph.style.shadows;
      // CSS paints the first shadow over the later ones
      for (let i = shadows.length - 1; i >= 0; i--) {
        const shadow = shadows[i];
        ctx.save();
        ctx.fillStyle = glyph.style.color;
        ctx.shadowColor = shadow.color;
        ctx.shadowBlur = shadow.blur;
        ctx.shadowOffsetX = shadow.offsetX + OFF_CANVAS;
        ctx.shadowOffsetY = shadow.offsetY;
        ctx.fillText(glyph.char, glyph.x - OFF_CANVAS, glyph.y);
        ctx.restore();
      }
      ctx.fillStyle = glyph.style.color;
      ctx.fillText(glyph.char, glyph.x, glyph.y);
    }
    if (clipped) ctx.restore();
  };

  /* ── WebGL2 ── */

  const compile = (gl, type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('warp-text: shader failed to compile.', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  };

  const createProgram = (gl) => {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = vertex && compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vertex || !fragment) {
      if (vertex) gl.deleteShader(vertex);
      return null;
    }
    const program = gl.createProgram();
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('warp-text: program failed to link.', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  };

  // ogl's Triangle: three vertices that cover clip space, uv running 0..2 so
  // the visible quadrant maps 0..1.
  const createTriangle = (gl, program) => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffers = [];
    const attributes = [
      ['position', [-1, -1, 3, -1, -1, 3]],
      ['uv', [0, 0, 2, 0, 0, 2]]
    ];
    attributes.forEach(([name, data]) => {
      const location = gl.getAttribLocation(program, name);
      if (location < 0) return;
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      buffers.push(buffer);
    });
    gl.bindVertexArray(null);
    return { vao, buffers };
  };

  const UNIFORMS = [
    'uTextTexture',
    'uResolution',
    'uPointer',
    'uPointerActive',
    'uTime',
    'uWarpStrength',
    'uWarpScale',
    'uSpeed',
    'uPointerInfluence',
    'uPointerStrength',
    'uRefraction',
    'uRipple',
    'uMotion'
  ];

  /* ── instance ── */

  const mount = (host, startLive) => {
    const config = readConfig(host);

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    host.appendChild(canvas);

    // reused across traces -- allocating one of these per frame during the
    // reveal would hand the GC a stream of multi-megabyte canvases
    const textCanvas = document.createElement('canvas');
    const textCtx = textCanvas.getContext('2d');
    if (!textCtx) {
      host.removeChild(canvas);
      return null;
    }

    const gl = canvas.getContext('webgl2', {
      alpha: true,
      // the shader emits straight alpha and the single triangle covers every
      // pixel of a cleared buffer exactly once, so blending stays off and the
      // compositor gets the colour it expects -- blending here would premultiply
      // a buffer the page then treats as un-premultiplied and darken the
      // antialiased glyph edges.
      premultipliedAlpha: false,
      // no polygon edges land inside the viewport; MSAA would only cost a
      // second multisampled buffer next to the page's other GL context.
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'low-power'
    });
    if (!gl) {
      host.removeChild(canvas);
      return null;
    }

    const program = createProgram(gl);
    if (!program) {
      host.removeChild(canvas);
      return null;
    }

    const { vao, buffers } = createTriangle(gl, program);
    const location = {};
    UNIFORMS.forEach((name) => {
      location[name] = gl.getUniformLocation(program, name);
    });

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // one context, one program, one texture: bind the lot once and leave it
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.clearColor(0, 0, 0, 0);
    gl.uniform1i(location.uTextTexture, 0);
    // start fully off: these are driven by the hover amount from `update`, and
    // at zero the first painted frame is the crisp trace exactly
    gl.uniform1f(location.uWarpStrength, 0);
    gl.uniform1f(location.uWarpScale, config.warpScale);
    gl.uniform1f(location.uSpeed, config.speed);
    gl.uniform1f(location.uPointerInfluence, config.pointerInfluence);
    gl.uniform1f(location.uPointerStrength, config.pointerStrength);
    gl.uniform1f(location.uRefraction, 0);
    gl.uniform1f(location.uRipple, config.ripple ? 1 : 0);
    gl.uniform1f(location.uMotion, 1);

    const startTime = performance.now();
    const pointer = { x: 0.5, y: 0.5, tx: 0.5, ty: 0.5, active: 0, activeTarget: 0 };
    const client = { x: 0, y: 0, tracking: false };
    const ticker = window.gsap ? window.gsap.ticker : null;

    let box = null;
    let boxDirty = true;
    let lastTime = 0;
    let lastTrace = 0;
    let rasterVersion = 0;
    let running = false;
    let rafId = 0;
    let disposed = false;
    let contextLost = false;
    let textureReady = false;
    let visible = true;
    let wasEngaged = false;
    // the headline is still revealing/rewriting itself, so a trace is stale the
    // moment it is taken and has to be redone every frame it is on screen
    let live = !!startLive;

    const render = () => {
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // One synchronous trace into the reusable text canvas. `quick` drops the
    // text-shadow passes, whose 60px blur is by far the priciest part of a
    // trace and which this headline's 0.03-alpha glow does not visibly need --
    // worth dropping while this runs once a frame through the intro.
    const traceInto = (quick) => {
      if (disposed || contextLost) return false;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;

      // supersample the trace so the warped resample stays crisp on 1x screens
      const dpr = Math.max(2, renderDpr());
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (textCanvas.width !== w || textCanvas.height !== h) {
        textCanvas.width = w; // resizing clears it
        textCanvas.height = h;
      } else {
        textCtx.setTransform(1, 0, 0, 1, 0, 0);
        textCtx.clearRect(0, 0, w, h);
      }

      textCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // only worth re-measuring the fonts on a full trace; during the live
      // window they have long since loaded and the sizes have not moved
      if (!quick) metricsCache.clear();
      drawGlyphs(textCtx, collectGlyphs(host, rect, textCtx, quick), quick);

      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);
      textureReady = true;
      return true;
    };

    const rasterize = async () => {
      const version = ++rasterVersion;
      if (document.fonts && document.fonts.ready) {
        try {
          await document.fonts.ready;
        } catch (e) {}
      }
      if (disposed || contextLost || version !== rasterVersion) return false;
      if (!traceInto(live)) return false;

      render();
      // The cursor may already be sitting on the headline by the time the first
      // trace lands, and no pointerenter fires for a cursor that was already
      // there -- so ask the element directly.
      if (host.matches(':hover')) {
        pointer.activeTarget = 1;
        boxDirty = true;
        showCanvas(true);
        startLoop();
      }
      return true;
    };

    const resize = () => {
      if (disposed || contextLost) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;

      const dpr = renderDpr();
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      box = rect;
      boxDirty = false;
      gl.viewport(0, 0, width, height);
      gl.uniform2f(location.uResolution, width, height);
      rasterize();
    };

    // Reading the box here rather than on every pointermove keeps the hero
    // parallax's style writes from forcing a layout each time the mouse moves;
    // the rect is only re-read once a scroll or resize has invalidated it.
    const trackPointer = () => {
      if (boxDirty) {
        box = canvas.getBoundingClientRect();
        boxDirty = false;
      }
      if (!client.tracking || !box || box.width <= 0 || box.height <= 0) return;
      pointer.tx = (client.x - box.left) / box.width;
      pointer.ty = 1 - (client.y - box.top) / box.height;
    };

    const writeUniforms = (amount, elapsed) => {
      gl.uniform2f(location.uPointer, pointer.x, pointer.y);
      gl.uniform1f(location.uPointerActive, amount);
      gl.uniform1f(location.uWarpStrength, config.warpStrength * amount);
      gl.uniform1f(location.uRefraction, config.refraction * amount);
      gl.uniform1f(location.uTime, elapsed);
    };

    const update = () => {
      if (disposed || contextLost) return;

      trackPointer();
      // Re-tracing follows the ~1.9s DOM reveal, and each trace is 43 glyph
      // rect reads interleaved with GSAP's writes to those same spans (forced
      // layout) plus a multi-MB texImage2D. 30Hz is indistinguishable from
      // 60Hz on an ease that long, and halves both costs.
      if (live) {
        const traceNow = performance.now();
        if (traceNow - lastTrace >= 32) { lastTrace = traceNow; traceInto(true); }
      }

      const now = performance.now();
      const elapsed = (now - startTime) * 0.001;
      // Exponential smoothing against real elapsed time. Upstream lerps by a
      // fixed fraction per *frame*, which makes the lens chase 2.4x faster on a
      // 144Hz panel than on 60Hz -- the whole feel of the thing would come out
      // differently depending on the display. The clamp keeps a resume after a
      // pause (tab switch, scrolled away) from snapping in one jump.
      const dt = lastTime ? Math.min((now - lastTime) * 0.001, 0.05) : 1 / 60;
      lastTime = now;
      const ease = (rate) => 1 - Math.exp(-rate * dt);

      const engaged = pointer.activeTarget > 0;
      if (engaged) {
        if (wasEngaged) {
          const follow = ease(MOTION.pointerFollow);
          pointer.x += (pointer.tx - pointer.x) * follow;
          pointer.y += (pointer.ty - pointer.y) * follow;
        } else {
          // arriving: put the lens under the cursor rather than letting it fly
          // in from wherever the last hover left it
          pointer.x = pointer.tx;
          pointer.y = pointer.ty;
        }
      }
      wasEngaged = engaged;
      pointer.active += ((engaged ? 1 : 0) - pointer.active) * ease(engaged ? MOTION.lensRise : MOTION.lensFall);

      // Off the headline with the ripple fully gone there is nothing left to
      // animate, so park the loop instead of burning a frame on it -- and give
      // the headline back to the DOM. 0.01 of the lens is ~0.1px of
      // displacement: invisible, and parking there rather than at zero saves
      // the last ~0.6s of pointless frames.
      if (!engaged && pointer.active <= 0.01) {
        pointer.active = 0;
        writeUniforms(0, elapsed);
        render();
        stopLoop();
        showCanvas(false);
        return;
      }

      writeUniforms(pointer.active, elapsed);
      render();
    };

    const tick = () => {
      if (!running) return;
      update();
      if (!running) return; // update() may have parked the loop
      rafId = requestAnimationFrame(tick);
    };

    // rides the page's existing gsap ticker where there is one, so the whole
    // site still animates off a single rAF
    const startLoop = () => {
      if (running || disposed || contextLost || !textureReady || !visible) return;
      running = true;
      lastTime = 0; // resuming: take the first frame at a nominal dt, not the gap
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

    // fade the glass in over the crisp text, then drop the crisp text once it
    // is fully hidden behind it -- crossfading both at once would dip in
    // brightness half way, since two half-opaque copies over a black page do
    // not add back up to one opaque copy.
    /* The WebGL copy is on screen only while something is hovering the
       headline. At rest the real DOM text shows: pixel for pixel, no
       resampling, nothing composited over it. That leaves the swap to happen
       under the ripple, where the effect arriving covers it, rather than
       cross-fading two identical copies of white type -- which double-exposes
       their antialiased edges and blooms.

       It also means a visitor who never touches the headline never pays for the
       per-frame re-trace and texture upload the intro would otherwise need. */
    const showCanvas = (on) => {
      if (disposed || !textureReady || on === host.classList.contains('is-warped')) return;
      // while the text is still changing, never show a trace from a moment ago
      if (on && live) {
        traceInto(true);
        render();
      }
      host.classList.toggle('is-warped', on);
    };

    const onPointerMove = (event) => {
      if (event.pointerType === 'touch') return;
      client.x = event.clientX;
      client.y = event.clientY;
      client.tracking = true;
    };

    // Engagement comes from the element's own hover rather than a hit test
    // against a cached rect: it needs no per-move layout read, and the browser
    // re-runs it after a scroll, so the ripple still catches when the headline
    // slides under a cursor that never moved.
    const onHostEnter = (event) => {
      if (event.pointerType === 'touch') return;
      client.x = event.clientX;
      client.y = event.clientY;
      client.tracking = true;
      boxDirty = true;
      pointer.activeTarget = 1;
      showCanvas(true); // swap in the WebGL copy for as long as this hover lasts
      startLoop(); //     the loop parks when idle, so arriving has to wake it
    };

    const onHostLeave = (event) => {
      if (event && event.pointerType === 'touch') return;
      pointer.activeTarget = 0;
      startLoop(); // no-op if already running; needed to animate the fade out
    };

    // the headline can move without changing size -- scrolling, or a viewport
    // height change against the hero's `calc(100vh - 80px)` -- and neither
    // trips the ResizeObserver, so the cached pointer box is invalidated here.
    const onGeometryChange = () => {
      boxDirty = true;
    };

    const onContextLost = (event) => {
      event.preventDefault();
      contextLost = true;
      stopLoop();
      // hand the headline back to the DOM rather than leaving a blank gap
      host.classList.remove('is-warped');
    };

    // resize() reallocates the GL backing store and re-traces every glyph, so
    // coalesce bursts (desktop drag, mobile address-bar collapse) into one frame
    let resizePending = 0;
    const resizeObserver = new ResizeObserver(() => {
      boxDirty = true;
      if (resizePending) return;
      resizePending = requestAnimationFrame(() => { resizePending = 0; resize(); });
    });
    resizeObserver.observe(host);

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        boxDirty = true;
        // only worth running while the headline is on screen *and* something is
        // still rippling on it
        if (!visible) stopLoop();
        else if (pointer.activeTarget > 0 || pointer.active > 0) startLoop();
      },
      { threshold: 0 }
    );
    intersectionObserver.observe(host);

    canvas.addEventListener('webglcontextlost', onContextLost, false);
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', onGeometryChange, { passive: true });
    window.addEventListener('resize', onGeometryChange);
    host.addEventListener('pointerenter', onHostEnter);
    host.addEventListener('pointerleave', onHostLeave);

    resize();

    return {
      // Called once the reveal has landed and the glyphs hold still: take one
      // full-fidelity trace, shadows included. From here the text no longer
      // changes, so that trace stays valid and a later hover costs nothing but
      // a class toggle.
      settle() {
        if (disposed || !live) return;
        live = false;
        if (traceInto(false)) render();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        stopLoop();
        if (resizePending) cancelAnimationFrame(resizePending);
        resizeObserver.disconnect();
        intersectionObserver.disconnect();
        canvas.removeEventListener('webglcontextlost', onContextLost);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('scroll', onGeometryChange);
        window.removeEventListener('resize', onGeometryChange);
        host.removeEventListener('pointerenter', onHostEnter);
        host.removeEventListener('pointerleave', onHostLeave);
        host.classList.remove('is-warped');

        if (!contextLost) {
          try {
            gl.deleteTexture(texture);
            gl.deleteVertexArray(vao);
            buffers.forEach((buffer) => gl.deleteBuffer(buffer));
            gl.deleteProgram(program);
            const lose = gl.getExtension('WEBGL_lose_context');
            if (lose) lose.loseContext();
          } catch (e) {}
        }
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  };

  /* ── wiring ── */

  const hosts = Array.prototype.slice.call(document.querySelectorAll('.warp-text'));
  if (!hosts.length || window.__NO_GPU) return;

  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  // Nothing to show on a device that cannot hover, and the site already hides
  // its custom cursor at this same breakpoint -- so skip the GL context whole.
  const noHover = window.matchMedia ? window.matchMedia('(hover: none)') : null;
  const instances = [];
  let traceable = false; // the line reveal has finished, so glyph positions hold still
  let settled = false; //   ...and it has stopped moving them

  const mountAll = () => {
    if (instances.length) return;
    hosts.forEach((host) => {
      const instance = mount(host, !settled);
      if (instance) instances.push(instance);
    });
  };

  const unmountAll = () => {
    while (instances.length) instances.pop().dispose();
  };

  // Under reduced motion the headline simply stays as DOM text: freezing the
  // shader would still trade hinted type for a resampled texture and buy the
  // reader nothing. Same outcome, different reason, where there is no hover.
  const apply = () => {
    if (!traceable) return;
    if ((reduceMotion && reduceMotion.matches) || (noHover && noHover.matches)) unmountAll();
    else mountAll();
  };

  if (reduceMotion && reduceMotion.addEventListener) reduceMotion.addEventListener('change', apply);
  if (noHover && noHover.addEventListener) noHover.addEventListener('change', apply);

  /* Two signals from index.html, because the headline stops moving before it
     stops changing:

     `hero:live`    the line reveal is done, so glyphs hold still and a trace is
                    valid. The reveal is still playing, so the canvas re-traces
                    every frame to follow it -- which is what lets the ripple
                    work on the headline mid-intro.
     `hero:settled` the reveal has landed: take a last full trace and stop. */
  const onLive = () => {
    traceable = true;
    apply();
  };

  const onSettled = () => {
    settled = true;
    onLive(); // mounts if `hero:live` never fired, e.g. the deep-link path
    instances.forEach((instance) => instance.settle());
  };

  if (document.body.dataset.heroSettled === '1') onSettled();
  else {
    if (document.body.dataset.heroLive === '1') onLive();
    else document.body.addEventListener('hero:live', onLive, { once: true });
    document.body.addEventListener('hero:settled', onSettled, { once: true });
  }
})();
