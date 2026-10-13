/**
 * landing.js — motion and data wiring for the landing page.
 * -----------------------------------------------------------------------------
 * Everything here is progressive enhancement. The page is fully readable with no
 * JavaScript at all and with JavaScript but no CDN libraries (the motion layer
 * checks for gsap/ScrollTrigger/Lenis first and, if they are missing or the
 * visitor asked for reduced motion, adds `.no-motion` and leaves layout alone).
 *
 * The only things this file *must* do are content: the replay ledger, the
 * marquee, the sparkline and the run data. Those are local, so they always work.
 */
import { RunReplay } from './replay.js';
import { drawGrid } from './gridview.js';
// The scoreboard renders the SAME figures the live dashboard does, from the
// recorded run's own metrics. Sharing the builders is the point: the landing
// page's numbers and the dashboard's numbers are the same quantities, so they
// must not be drawn by two different pieces of code.
import { reliabilityChart, rocChart, confusionChart } from './charts.js';
import { initThemeToggle } from './theme-toggle.js';

const SIMPLEX_CDN = 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/+esm';
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const HAS_GSAP = typeof window.gsap !== 'undefined' && typeof window.ScrollTrigger !== 'undefined';
const MOTION = HAS_GSAP && !REDUCED;

if (!MOTION) document.documentElement.classList.add('no-motion');

/* ==========================================================================
   1. Smooth scrolling (Lenis) + ScrollTrigger
   Lenis drives the document; ScrollTrigger must read from Lenis rather than
   from native scroll events, or scrubbed animations lag a frame behind.
   ========================================================================== */
function initSmoothScroll() {
  const LenisCtor = window.Lenis;
  if (!MOTION || typeof LenisCtor !== 'function') return null;

  const lenis = new LenisCtor({
    duration: 1.05,
    wheelMultiplier: 0.9,
    touchMultiplier: 1.4,
    // Anchor links and any programmatic scroll keep the same feel.
    easing: (t) => 1 - Math.pow(1 - t, 3),
  });

  window.gsap.ticker.add((time) => lenis.raf(time * 1000));
  window.gsap.ticker.lagSmoothing(0);
  lenis.on('scroll', window.ScrollTrigger.update);

  // Same-page anchors: hand them to Lenis instead of the browser jump.
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (id.length < 2) return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      lenis.scrollTo(target, { offset: -70, duration: 1.2 });
    });
  });
  return lenis;
}

/** Sticky nav gets a hairline only once the page has moved. */
function initNav() {
  const nav = document.getElementById('nav');
  const check = () => nav.classList.toggle('is-stuck', window.scrollY > 8);
  check();
  if (MOTION) window.gsap.ticker.add(check);
  else window.addEventListener('scroll', check, { passive: true });
}

/* ==========================================================================
   2. Hero flow field
   420 particles advected through a curl-ish noise field, drawn as faint cyan
   streaks over near-black with a slow fade, so the trail reads as flow rather
   than dots. The pointer perturbs the field — the page says the cursor is a
   sample, and this is that claim made literal.
   ========================================================================== */
async function initFlowField() {
  const canvas = document.getElementById('flow');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: false });

  // Prefer the pinned simplex-noise build; if the CDN is unreachable, fall back
  // to a cheap trigonometric field so the hero still moves.
  let noise = null;
  try {
    const mod = await import(/* @vite-ignore */ SIMPLEX_CDN);
    const n2 = mod.createNoise2D();
    noise = (x, y) => n2(x, y);
  } catch (_) {
    noise = (x, y) => Math.sin(x * 1.7 + Math.cos(y * 1.3) * 2.2) * Math.cos(y * 1.1 + Math.sin(x) * 1.8);
  }

  const DPR = Math.min(2, window.devicePixelRatio || 1);
  const COUNT = 420;
  const particles = [];
  const pointer = { x: -1e4, y: -1e4 };
  let w = 0;
  let h = 0;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    w = Math.max(320, rect.width);
    h = Math.max(320, rect.height);
    canvas.width = Math.round(w * DPR);
    canvas.height = Math.round(h * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
  };

  const spawn = () => {
    particles.length = 0;
    for (let i = 0; i < COUNT; i++) {
      particles.push({ x: Math.random() * w, y: Math.random() * h, speed: 0.35 + Math.random() * 0.5 });
    }
  };

  /** Angle of the flow at (x, y) for time t. */
  const field = (x, y, t) =>
    noise(x * 0.0016, y * 0.0016 + t * 0.00006) * Math.PI * 1.7 +
    noise(x * 0.0042 + 40, y * 0.0042 - t * 0.00009) * Math.PI * 0.5;

  const step = (t) => {
    // Slow fade instead of a clear: this is what makes the streaks trail.
    ctx.fillStyle = 'rgba(42, 26, 26, 0.05)';
    ctx.fillRect(0, 0, w, h);
    ctx.lineWidth = 1;
    for (const p of particles) {
      const angle = field(p.x, p.y, t);
      let vx = Math.cos(angle) * p.speed;
      let vy = Math.sin(angle) * p.speed;

      // Pointer: pull particles toward the cursor inside a 130px radius.
      const dx = pointer.x - p.x;
      const dy = pointer.y - p.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 16900) {
        const pull = (1 - Math.sqrt(d2) / 130) * 0.55;
        vx += (dx / (Math.sqrt(d2) || 1)) * pull;
        vy += (dy / (Math.sqrt(d2) || 1)) * pull;
      }

      const nx = p.x + vx;
      const ny = p.y + vy;
      ctx.strokeStyle = 'rgba(248, 104, 0, 0.06)';
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      p.x = nx;
      p.y = ny;
      if (p.x < -20) p.x = w + 20;
      if (p.x > w + 20) p.x = -20;
      if (p.y < -20) p.y = h + 20;
      if (p.y > h + 20) p.y = -20;
    }
  };

  resize();
  spawn();

  // The cursor perturbs the field. `pointerleave` only fires on elements that
  // can be left, so this listens on <html> rather than on window.
  window.addEventListener('pointermove', (e) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = e.clientX - rect.left;
    pointer.y = e.clientY - rect.top;
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    pointer.x = -1e4;
    pointer.y = -1e4;
  });

  let visible = true;
  let running = true;

  /**
   * Paint settled streaks — the still version of this canvas. Used for reduced
   * motion, and by the motion watchdog if this environment never pumps frames
   * (a background/throttled tab would otherwise show an empty black box).
   */
  const settle = () => {
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 320; i++) step(i * 16);
  };

  const loop = (t) => {
    if (!running) return;
    if (visible && !document.hidden) step(t || 0);
    requestAnimationFrame(loop);
  };

  if (REDUCED) {
    settle();
    return { settle, stop: () => { running = false; } };
  }

  // Nothing animates while the hero is off-screen or the tab is hidden.
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; }, { threshold: 0.02 })
      .observe(canvas);
  }
  window.addEventListener('resize', () => { resize(); spawn(); }, { passive: true });
  requestAnimationFrame(loop);
  return { settle, stop: () => { running = false; } };
}

/* ==========================================================================
   2b. Motion watchdog
   Some environments never pump animation frames (throttled or un-composited
   webviews). There, a rAF-driven page is worse than a plain one: Lenis would
   swallow wheel events and nothing would move. If frames are missing — or a
   wheel gesture produces no scroll — hand scrolling back to the browser and
   settle the hero into its static state.
   ========================================================================== */
function initMotionWatchdog(flow, lenis) {
  let degraded = false;
  const targets = [...document.querySelectorAll('.reveal')];

  const degrade = (reason) => {
    if (degraded) return;
    degraded = true;
    document.documentElement.classList.add('no-motion');
    if (flow) flow.settle();
    if (window.gsap && targets.length) window.gsap.set(targets, { opacity: 1, y: 0, clearProps: 'transform' });
    if (lenis && typeof lenis.destroy === 'function') lenis.destroy();
    window.__lenis = null;
    console.info(`[landing] motion degraded to static (${reason})`);
  };

  // (a) Are frames arriving at all once the page has settled down?
  let frames = 0;
  let counting = true;
  const count = () => {
    if (!counting) return;
    frames++;
    requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  setTimeout(() => {
    counting = false;
    if (frames < 3) degrade('no animation frames');
  }, 1600);

  // (b) A wheel gesture that changes nothing means the smooth-scroll layer is
  //     holding the page hostage. Boundaries are exempt (there is nowhere to go).
  window.addEventListener('wheel', () => {
    const before = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    setTimeout(() => {
      const stuckMidPage = window.scrollY === before && before > 0 && before < max - 4;
      if (stuckMidPage) degrade('wheel ignored');
    }, 520);
  }, { passive: true });
}

/* ==========================================================================
   3. Reveals + hero typography
   Short, eased, staggered. 14px of travel and opacity, nothing that slides
   across the screen. Words in the headline rise individually.
   ========================================================================== */
function splitWords(el) {
  const words = [];
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const parts = child.textContent.split(/(\s+)/).filter((s) => s.length);
        const frag = document.createDocumentFragment();
        parts.forEach((part) => {
          if (/^\s+$/.test(part)) {
            frag.appendChild(document.createTextNode(part));
            return;
          }
          const span = document.createElement('span');
          span.style.display = 'inline-block';
          span.textContent = part;
          frag.appendChild(span);
          words.push(span);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        walk(child);
      }
    });
  };
  walk(el);
  return words;
}

function initReveals() {
  const gsap = window.gsap;
  const ScrollTrigger = window.ScrollTrigger;
  const targets = [...document.querySelectorAll('[data-reveal]')];

  // Headline: split, then rise. Runs before anything scroll-dependent so the
  // hero is never stuck half-visible.
  const headline = document.querySelector('.hero h1');
  if (MOTION && headline) {
    const words = splitWords(headline);
    gsap.from(words, { yPercent: 105, opacity: 0, duration: 0.9, ease: 'power3.out', stagger: 0.038, delay: 0.12 });
    gsap.from('.hero .eyebrow, .hero .lede, .hero .actions, .hero .hint', {
      y: 14, opacity: 0, duration: 0.7, ease: 'power2.out', stagger: 0.07, delay: 0.34,
    });
  }

  if (!targets.length) return;
  targets.forEach((el) => el.classList.add('reveal'));
  if (!MOTION) return;

  gsap.set(targets, { opacity: 0, y: 14 });
  ScrollTrigger.batch(targets, {
    start: 'top 88%',
    once: true,
    onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 0.62, ease: 'power2.out', stagger: 0.06, overwrite: true }),
  });

  // Safety net: a marketing page must never lose content to a failed trigger.
  setTimeout(() => {
    const stuck = targets.filter((el) => Number(window.getComputedStyle(el).opacity) < 0.9);
    if (stuck.length) gsap.set(stuck, { opacity: 1, y: 0 });
  }, 3000);
}

/* ==========================================================================
   4. The method sequence — the page's one pinned, scrubbed moment
   CSS position: sticky holds the stage; ScrollTrigger only reports progress,
   which keeps us clear of pin-spacer layout bugs. The four states are real
   frames from the recording (0, 6, 12, 17), not illustrations.
   ========================================================================== */
function initMethod(data) {
  const frames = data.frames;
  const cfg = data.config;
  const steps = [...document.querySelectorAll('#method-steps .step')];
  // The number of stages is whatever the markup defines — sample that many real
  // frames, evenly spread across the recording. Hard-coding both the stage count
  // and the frame indices here meant a longer run silently reused old frames.
  const picks = steps.map((_, i) =>
    Math.round((i * (frames.length - 1)) / Math.max(1, steps.length - 1)));
  const canvas = document.getElementById('method-canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  const out = {
    entropy: document.getElementById('readout-entropy'),
    peak: document.getElementById('readout-peak'),
    battery: document.getElementById('readout-battery'),
    label: document.getElementById('method-step-label'),
    note: document.getElementById('method-note'),
  };

  const show = (stage) => {
    const idx = picks[stage];
    const f = frames[idx];
    drawGrid(ctx, {
      width: cfg.width,
      height: cfg.height,
      belief: gridFromFlat(f.belief, cfg.width, cfg.height),
      path: frames.slice(0, idx + 1).map((fr) => fr.pos),
      pos: f.pos,
      peak: f.peak,
      stations: cfg.stations,
      obstacles: cfg.obstacles,
      eve: data.outcome.eve,
      found: false,
    });
    steps.forEach((el, i) => el.classList.toggle('is-active', i === stage));
    out.entropy.textContent = Math.abs(f.entropy).toFixed(3);
    out.peak.textContent = `(${f.peak.x},${f.peak.y})`;
    out.battery.textContent = String(f.battery);
    out.label.textContent = `frame ${idx} · step ${f.step} · ${f.action}`;
    out.note.textContent = f.reasoning.replace(/^Belief peak [^.]*\.\s*/, '').slice(0, 92);
  };

  show(0);

  // Narrow screens (and no-JS/ no-GSAP visitors) get all four states readable.
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  if (!MOTION || narrow) {
    steps.forEach((el) => el.classList.add('is-active'));
    return;
  }

  let stage = -1;
  const last = steps.length - 1;
  window.ScrollTrigger.create({
    trigger: '#method-pin',
    start: 'top top+=100',
    end: 'bottom bottom',
    onUpdate: (self) => {
      // One state per step, spread across the sticky track; the +0.02 keeps the
      // final state from being unreachable when progress lands just under 1.
      const next = Math.min(last, Math.floor(self.progress * (steps.length + 0.02)));
      if (next !== stage) {
        stage = next;
        show(next);
      }
    },
  });
}

/* ==========================================================================
   4b. The scoreboard
   The recorded run is scored against EVE's real cell after every step. Those
   scores are the only numbers on this page that come from ground truth, so they
   are also the only ones that can be embarrassing — which is why they are here.
   ========================================================================== */
function initScores(data) {
  const m = data.outcome && data.outcome.metrics;
  if (!m) return;

  // Fill the tiles from the recording, leaving the prose (which lives in the
  // markup, so a reader with no JavaScript still gets the sentence) alone.
  const finalFrame = data.frames[data.frames.length - 1] || {};
  const fill = {
    auc: () => m.auc.toFixed(3),
    log_loss: () => m.log_loss.toFixed(2),
    brier: () => m.brier.toFixed(3),
    topk: () => `${Math.round(m.top1_accuracy * 100)}% / ${Math.round(m.top3_accuracy * 100)}%`,
    detect: () => `${m.detection.precision.toFixed(2)} / ${m.detection.recall.toFixed(2)}`,
    credible: () => `${data.frames[0].credible} → ${finalFrame.credible ?? '—'} cells`,
  };
  document.querySelectorAll('#score-grid .score').forEach((tile) => {
    const fn = fill[tile.dataset.score];
    const b = tile.querySelector('b');
    if (fn && b) b.textContent = fn();
  });

  const calibFig = document.getElementById('calib-fig');
  if (calibFig) calibFig.innerHTML = reliabilityChart(m.calibration);
  const rocFig = document.getElementById('roc-fig');
  if (rocFig) rocFig.innerHTML = rocChart(m.roc);
  const cmFig = document.getElementById('cm-fig');
  if (cmFig) cmFig.innerHTML = confusionChart(m.detection);

  const calibNote = document.getElementById('calib-note');
  if (calibNote) calibNote.textContent = `${m.steps_scored} steps scored`;
  const rocNote = document.getElementById('roc-note');
  if (rocNote) rocNote.textContent = `AUC ${m.auc.toFixed(3)}`;
}

/**
 * Reveal the scoreboard figures as they scroll in. Purely additive: the markup
 * is already in the document, so nothing is lost if this never runs.
 */
function initScoreReveals() {
  const figs = [...document.querySelectorAll('.score-figs .frame')];
  if (!figs.length) return;
  figs.forEach((el) => el.classList.add('reveal'));
  if (!MOTION) {
    figs.forEach((el) => el.classList.remove('reveal'));
    return;
  }
  window.gsap.set(figs, { opacity: 0, y: 18 });
  window.ScrollTrigger.batch(figs, {
    start: 'top 90%',
    once: true,
    onEnter: (batch) => window.gsap.to(batch, { opacity: 1, y: 0, duration: 0.6, ease: 'power2.out', stagger: 0.08 }),
  });
}

/** Flat 100-int belief array → [y][x]. */
function gridFromFlat(flat, w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(flat.slice(y * w, (y + 1) * w));
  return rows;
}

/* ==========================================================================
   5. Replay wiring: transport, marquee, sparkline, autoplay-once
   ========================================================================== */
async function initReplay() {
  const replay = new RunReplay({
    canvas: document.getElementById('replay-canvas'),
    ledgerBody: document.getElementById('ledger-body'),
    counter: document.getElementById('replay-counter'),
    scrub: document.getElementById('replay-scrub'),
    playBtn: document.getElementById('replay-play'),
    playIcon: document.getElementById('replay-icon'),
    stepBtn: document.getElementById('replay-step'),
    actionLabel: document.getElementById('replay-action'),
    entropyLabel: document.getElementById('replay-entropy'),
  });

  let data;
  try {
    data = await replay.load();
  } catch (err) {
    // The static copy in the HTML stays; nothing here is required for the page.
    console.warn('replay data unavailable:', err.message);
    return null;
  }

  // --- marquee built from the run's own lines (duplicated for a seamless loop)
  const marquee = document.getElementById('marquee');
  if (marquee) {
    const lines = replay.marqueeLines();
    const doubled = lines.concat(lines);
    marquee.replaceChildren(...doubled.map((text) => {
      const span = document.createElement('span');
      const [head, ...rest] = text.split(' ');
      span.innerHTML = `<i>${head}</i> ${rest.join(' ')}`;
      return span;
    }));
  }

  // --- entropy sparkline, drawn from the same frames
  const sparkHolder = document.getElementById('spark');
  if (sparkHolder) {
    const { svg } = replay.sparkline();
    sparkHolder.innerHTML = svg;
    const line = sparkHolder.querySelector('.line');
    const end = document.getElementById('spark-end');
    if (end) end.textContent = Math.abs(data.frames[data.frames.length - 1].entropy).toFixed(2);
    if (MOTION && line) {
      window.gsap.fromTo(line,
        { strokeDasharray: 1, strokeDashoffset: 1 },
        { strokeDashoffset: 0, duration: 1.8, ease: 'power2.inOut',
          scrollTrigger: { trigger: sparkHolder, start: 'top 85%', once: true } });
    }
  }

  // --- autoplay once, when the section first comes into view
  const run = document.getElementById('run');
  if (MOTION && run && 'IntersectionObserver' in window) {
    const once = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      once.disconnect();
      replay.play();
    }, { threshold: 0.35 });
    once.observe(run);

    // ...and pause if the reader scrolls away mid-run.
    new IntersectionObserver(([entry]) => { if (!entry.isIntersecting) replay.pause(); }, { threshold: 0.05 })
      .observe(run);
  }

  // --- "replay the recorded run" button in the closing card
  const again = document.getElementById('replay-again');
  if (again) {
    again.addEventListener('click', () => {
      replay.goTo(0);
      replay.play();
      const smooth = window.Lenis && window.__lenis;
      if (smooth) smooth.scrollTo(document.getElementById('run'), { offset: -70, duration: 1.1 });
      else document.getElementById('run').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth' });
    });
  }
  return data;
}

/* ==========================================================================
   boot
   ========================================================================== */
async function boot() {
  // Unconditional marker: the guard in index.html waits for this to confirm the
  // module graph actually executed. Set first so it's true even if a later step
  // (e.g. a blocked CDN for motion) degrades gracefully.
  window.__landingBooted = true;
  initThemeToggle();
  const lenis = initSmoothScroll();
  if (lenis) window.__lenis = lenis;
  initNav();
  initReveals();
  const [flow, data] = await Promise.all([initFlowField(), initReplay()]);
  if (data) {
    initMethod(data);
    initScores(data);
    initScoreReveals();
  }
  initMotionWatchdog(flow, lenis);
}

boot();
