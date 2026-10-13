/**
 * fx.js — button particles.
 * -----------------------------------------------------------------------------
 * Self-initialising, used by BOTH pages (landing and dashboard). One delegated
 * listener pair, no per-button wiring, so it keeps working for buttons that are
 * created later (the briefing modal's actions, for instance).
 *
 * Two effects, deliberately different in weight:
 *
 *   click   a burst of accent particles sprayed from the exact click point,
 *           thrown outward with a little lift, fading as they fly.
 *   hover   a single small spark at the pointer, throttled. A button that
 *           continuously emits particles is a gimmick; a button that answers
 *           being touched is a material.
 *
 * Both use the Web Animations API, so the elements clean themselves up when the
 * animation finishes — there is no keyframe bookkeeping and no DOM growth if a
 * user leans on a button.
 */
(() => {
  const BURST = 14;
  const BURST_LIFE = 520;
  const SPARK_LIFE = 480;
  const SPARK_INTERVAL = 90;      // ms between hover sparks — throttled per pointer
  const TARGET = '.btn, button, .tbtn, .mini, [data-matrix], .mx-tab';
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Spawn one particle that flies to (dx, dy) and removes itself. */
  function particle(cls, x, y, dx, dy, life, size) {
    const p = document.createElement('span');
    p.className = cls;
    p.style.width = p.style.height = `${size}px`;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    document.body.appendChild(p);
    const anim = p.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 0.95 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0)`, opacity: 0 },
      ],
      { duration: life, easing: 'cubic-bezier(0.16, 0.84, 0.44, 1)' },
    );
    anim.onfinish = () => p.remove();
    anim.oncancel = () => p.remove();
    return anim;
  }

  document.addEventListener('click', (e) => {
    if (REDUCED) return;
    const btn = e.target instanceof Element ? e.target.closest(TARGET) : null;
    if (!btn || btn.disabled) return;

    const rect = btn.getBoundingClientRect();
    // Prefer the real pointer position; fall back to the button centre for
    // keyboard activation (Enter/Space fire a click with no coordinates).
    const cx = e.clientX || rect.left + rect.width / 2;
    const cy = e.clientY || rect.top + rect.height / 2;

    for (let i = 0; i < BURST; i++) {
      const angle = (i / BURST) * Math.PI * 2 + Math.random() * 0.5;
      const dist = 22 + Math.random() * 46;
      particle(
        'fx-particle', cx, cy,
        Math.cos(angle) * dist,
        Math.sin(angle) * dist - 16,          // a little lift so it reads as a puff
        BURST_LIFE + Math.random() * 260,
        2 + Math.random() * 3.5,
      );
    }
  }, { passive: true });

  // One spark at the pointer while it travels across a button, rate-limited so a
  // fast sweep across a toolbar does not spawn hundreds of nodes.
  let lastSpark = 0;
  document.addEventListener('mousemove', (e) => {
    if (REDUCED) return;
    const now = performance.now();
    if (now - lastSpark < SPARK_INTERVAL) return;
    const btn = e.target instanceof Element ? e.target.closest(TARGET) : null;
    if (!btn || btn.disabled) return;
    lastSpark = now;
    const jitter = 7;
    particle(
      'fx-spark', e.clientX, e.clientY,
      (Math.random() - 0.5) * jitter * 2,
      (Math.random() - 0.5) * jitter * 2 - 4,
      SPARK_LIFE,
      2 + Math.random() * 1.6,
    );
  }, { passive: true });
})();
