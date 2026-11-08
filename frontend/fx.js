// Generated-light visuals: a WebGL ribbon hero that reacts to the mic, a live spectrum field,
// a one-time intro and scroll reveals. Everything is cancelled under prefers-reduced-motion.

const $ = (id) => document.getElementById(id);
const CALM = matchMedia("(prefers-reduced-motion: reduce)").matches;

// The app writes the mic level and analyser here while recording; the canvases read it.
export const audio = { level: 0, analyser: null, sampleRate: 48000 };

export function initFx() {
  const hero = $("hero");
  splitHeadline($("headline"));
  runIntro(hero);
  initShader($("shader"), hero);
  initSpectrum($("spectrum"), $("hz"));
  initReveal();
}

// ---------------------------------------------------------------- headline and intro

function splitHeadline(h1) {
  const lines = (h1.dataset.text || h1.textContent).split("|");
  h1.setAttribute("aria-label", lines.join(" "));
  h1.textContent = "";
  let i = 0;
  for (const text of lines) {
    const row = document.createElement("span");
    row.className = "line";
    row.setAttribute("aria-hidden", "true");
    for (const ch of text) {
      const g = document.createElement("span");
      g.className = "glyph";
      g.textContent = ch === " " ? " " : ch;
      g.style.transitionDelay = `${i * 42}ms`;
      row.append(g);
      i++;
    }
    h1.append(row);
  }
}

function runIntro(hero) {
  const intro = $("intro");
  if (!document.documentElement.classList.contains("intro-on")) {
    intro?.remove();
    hero.classList.add("in");
    return;
  }
  try {
    sessionStorage.setItem("karyam.intro", "1");
  } catch {
    /* fine: the intro just plays again next load */
  }
  setTimeout(() => intro.classList.add("show"), 220);
  setTimeout(() => intro.classList.add("lift"), 1500);
  setTimeout(() => {
    intro.classList.add("out");
    hero.classList.add("in");
  }, 2050);
  setTimeout(() => intro.remove(), 3000);
}

// ---------------------------------------------------------------- shared canvas helpers

function fit(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width * dpr));
  const h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { w, h, dpr, cssW: r.width, cssH: r.height };
}

// Runs draw(seconds) every frame while the element is on screen. Under reduced motion it draws one still frame.
function runLoop(target, draw) {
  let raf = 0;
  let visible = true;
  const tick = (ms) => {
    if (!visible) {
      raf = 0;
      return;
    }
    draw(ms / 1000);
    raf = requestAnimationFrame(tick);
  };
  const start = () => {
    if (!raf && !CALM) raf = requestAnimationFrame(tick);
  };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) start();
    }).observe(target);
  }
  if ("ResizeObserver" in window) new ResizeObserver(() => CALM && draw(3)).observe(target);
  if (CALM) draw(3);
  else start();
}

// ---------------------------------------------------------------- ribbon hero

const VERT = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }";
const FRAG = `
precision mediump float;
uniform vec2 u_res;
uniform float u_time;
uniform float u_level;

float ribbon(vec2 uv, float t, float phase, float freq, float amp, float width) {
  float y = 0.5 + amp * sin(uv.x * freq + t * 0.6 + phase) + 0.5 * amp * sin(uv.x * freq * 2.1 - t * 0.4 + phase * 1.7);
  return smoothstep(width, 0.0, abs(uv.y - y));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float amp = 0.09 + 0.17 * u_level;
  float w = 0.07 + 0.06 * u_level;
  float a = ribbon(uv, u_time, 0.0, 5.0, amp, w);
  float b = ribbon(uv, u_time, 2.1, 4.2, amp * 1.15, w);
  float c = ribbon(uv, u_time, 4.2, 6.1, amp * 0.9, w);
  vec3 indigo = vec3(0.388, 0.400, 0.945);
  vec3 violet = vec3(0.545, 0.361, 0.965);
  vec3 cyan = vec3(0.133, 0.827, 0.933);
  float bloom = a * b + b * c + a * c;
  vec3 col = a * indigo + b * violet + c * cyan + bloom * vec3(0.55, 0.6, 0.85);
  float glow = exp(-pow(length((uv - vec2(0.5)) * vec2(1.0, 1.7)), 2.0) * 3.0) * (0.07 + 0.08 * u_level);
  col += glow * indigo;
  float alpha = clamp(a + b + c + bloom + glow, 0.0, 1.0);
  gl_FragColor = vec4(min(col, vec3(alpha)), alpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
  return s;
}

function webglRenderer(canvas) {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) throw new Error("no webgl");
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link failed");
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uRes = gl.getUniformLocation(prog, "u_res");
  const uTime = gl.getUniformLocation(prog, "u_time");
  const uLevel = gl.getUniformLocation(prog, "u_level");
  return (t, level) => {
    const { w, h } = fit(canvas);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(uRes, w, h);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uLevel, level);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };
}

// Same three ribbons with plain 2D strokes, for browsers without WebGL.
function canvasRenderer(canvas) {
  const ctx = canvas.getContext("2d");
  const ribbons = [
    { phase: 0, freq: 5, amp: 1, color: "99,102,241" },
    { phase: 2.1, freq: 4.2, amp: 1.15, color: "139,92,246" },
    { phase: 4.2, freq: 6.1, amp: 0.9, color: "34,211,238" },
  ];
  return (t, level) => {
    const { w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = h * (0.09 + 0.07 * level);
    const amp = 0.09 + 0.17 * level;
    for (const r of ribbons) {
      ctx.strokeStyle = `rgba(${r.color},0.42)`;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) {
        const u = x / w;
        const y = 0.5 + amp * r.amp * Math.sin(u * r.freq + t * 0.6 + r.phase) + 0.5 * amp * r.amp * Math.sin(u * r.freq * 2.1 - t * 0.4 + r.phase * 1.7);
        if (x === 0) ctx.moveTo(x, (1 - y) * h);
        else ctx.lineTo(x, (1 - y) * h);
      }
      ctx.stroke();
    }
    ctx.globalCompositeOperation = "source-over";
  };
}

function initShader(canvas, hero) {
  let render;
  try {
    render = webglRenderer(canvas);
  } catch {
    // A canvas that already holds a WebGL context can't give out a 2D one, so swap in a fresh element.
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
    render = canvasRenderer(canvas);
  }
  let level = 0;
  runLoop(hero, (t) => {
    level += (audio.level - level) * 0.12;
    render(t, level);
  });
}

// ---------------------------------------------------------------- spectrum field

const BARS = 72;
const MAX_HZ = 8000;
const VOICE_LO = 300;
const VOICE_HI = 3400;

function initSpectrum(canvas, readout) {
  const ctx = canvas.getContext("2d");
  let data = null;
  let lastReadout = 0;
  let lastText = "";
  const setReadout = (text) => {
    if (text !== lastText) {
      readout.textContent = text;
      lastText = text;
    }
  };

  runLoop(canvas.parentElement, (t) => {
    const { dpr, cssW: W, cssH: H } = fit(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const analyser = audio.analyser;
    const values = new Array(BARS).fill(0);
    let peakHz = 0;
    let peak = 0;
    if (analyser) {
      if (!data || data.length !== analyser.frequencyBinCount) data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const binHz = audio.sampleRate / analyser.fftSize;
      for (let i = 0; i < BARS; i++) {
        const lo = Math.floor(((i * MAX_HZ) / BARS) / binHz);
        const hi = Math.max(lo + 1, Math.floor((((i + 1) * MAX_HZ) / BARS) / binHz));
        let sum = 0;
        for (let b = lo; b < hi && b < data.length; b++) sum += data[b];
        values[i] = sum / (hi - lo) / 255;
      }
      for (let b = Math.ceil(80 / binHz); b < data.length && b * binHz < MAX_HZ; b++) {
        if (data[b] > peak) {
          peak = data[b];
          peakHz = b * binHz;
        }
      }
    } else {
      for (let i = 0; i < BARS; i++) {
        const env = Math.sin((Math.PI * (i + 0.5)) / BARS);
        values[i] = env * (0.16 + 0.1 * Math.sin(t * 1.3 + i * 0.35) + 0.06 * Math.sin(t * 2.1 + i * 0.9));
      }
    }

    const padX = 16;
    const base = H - 40;
    const step = (W - padX * 2) / BARS;
    const bw = Math.max(2, step * 0.56);
    const selLo = Math.round((VOICE_LO / MAX_HZ) * BARS);
    const selHi = Math.round((VOICE_HI / MAX_HZ) * BARS);
    let top = base;
    for (let i = 0; i < BARS; i++) {
      const selected = i >= selLo && i <= selHi;
      const lift = selected ? 0.2 : 0;
      const h = Math.max(2, (lift + values[i] * (1 - lift)) * (base - 24));
      const x = padX + i * step + (step - bw) / 2;
      ctx.fillStyle = selected ? "#6366f1" : "rgba(255,255,255,0.16)";
      ctx.fillRect(x, base - h, bw, h);
      if (selected) top = Math.min(top, base - h);
    }
    // marker box around the selected run
    const x0 = padX + selLo * step - 6;
    const x1 = padX + (selHi + 1) * step + 6;
    ctx.strokeStyle = "rgba(99,102,241,0.7)";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x0) + 0.5, Math.round(top - 10) + 0.5, Math.round(x1 - x0), Math.round(base + 6 - (top - 10)));

    const now = performance.now();
    if (now - lastReadout > 120) {
      lastReadout = now;
      setReadout(analyser ? (peak > 60 ? `${Math.round(peakHz)} Hz` : "Listening") : "Idle");
    }
  });
}

// ---------------------------------------------------------------- scroll reveals

function initReveal() {
  const els = [...document.querySelectorAll(".reveal")];
  if (CALM || !("IntersectionObserver" in window)) {
    els.forEach((e) => e.classList.add("is-in"));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (en.isIntersecting) {
          en.target.classList.add("is-in");
          io.unobserve(en.target);
        }
      }
    },
    { threshold: 0.16, rootMargin: "0px 0px -8% 0px" },
  );
  els.forEach((e) => io.observe(e));
}
