/**
 * cursor.js — the circular "difference" lens.
 * -----------------------------------------------------------------------------
 * The pointer is replaced by a circle that has no colour of its own:
 * `mix-blend-mode: difference` against a white fill means it INVERTS whatever
 * sits behind it, so it behaves like a filter over the page rather than a sticker
 * on top of it. That is also why it needs no palette — it works over the flow
 * field, the dark panels and white text alike.
 *
 * Its SIZE is the second half of the idea, and it is a read-out of the pointer:
 *
 *   at rest        a small dot (R_MIN), so it disappears into the page
 *   accelerating   it swells, because the radius tracks BOTH speed and the
 *                  change in speed — a flick opens an aperture, a slow drag
 *                  barely moves it
 *   stopping       it relaxes back to the dot
 *
 * Why acceleration and not just speed: a constant slow drift and a sudden flick
 * can share a speed, but only one of them feels like a gesture. Adding the
 * acceleration term is what makes the lens feel attached to the hand.
 *
 * Everything is one rAF loop over two numbers. The pointer position is eased
 * toward the true position so the lens trails slightly, which is what stops it
 * from looking welded to the OS cursor. Nothing is written unless a fine pointer
 * is present, and `body.has-lens` — the class that hides the native arrow — is
 * only added once this file has confirmed it is going to draw something.
 */
(() => {
  const cursor = document.querySelector('.cursor');
  if (!cursor) return;

  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || reduced) {
    cursor.style.display = 'none';
    return;                     // touch devices and reduced motion keep the OS cursor
  }

  document.body.classList.add('has-lens');

  const pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const target = { x: pos.x, y: pos.y };
  const R_MIN = 5;              // radius at rest
  const R_MAX = 46;             // radius at full flick
  const FOLLOW = 0.2;           // position easing (0 = frozen, 1 = welded)
  const SPEED_GAIN = 0.5;       // px of radius per px/frame of speed
  const ACCEL_GAIN = 0.9;       // px of radius per px/frame² of acceleration
  const OPEN = 0.4;             // how fast the lens opens
  const CLOSE = 0.12;           // how fast it relaxes (slower: it must feel like settling)
  const HOVER_SCALE = 1.45;     // extra openness over anything clickable

  let radius = R_MIN;
  let prev = null;
  let speed = 0;
  let accel = 0;
  let hovering = false;

  document.addEventListener('mousemove', (e) => {
    target.x = e.clientX;
    target.y = e.clientY;
    if (prev) {
      // Smoothed per-frame speed, then the change in that speed.
      const d = Math.hypot(e.clientX - prev.x, e.clientY - prev.y);
      const next = speed * 0.55 + d * 0.45;
      accel = next - speed;      // |accel| is the gesture component
      speed = Math.min(next, 90);
    }
    prev = { x: e.clientX, y: e.clientY };
  }, { passive: true });

  // Anything that invites a click gets a bigger aperture, so the lens doubles as
  // an affordance cue. Delegated: it survives content replaced at runtime.
  const HOVERABLE = 'a, button, .btn, .tbtn, .frame, label, input, select, [data-matrix], .ledger-row';
  document.addEventListener('mouseover', (e) => {
    hovering = Boolean(e.target instanceof Element && e.target.closest(HOVERABLE));
  }, { passive: true });

  document.addEventListener('mouseleave', () => { cursor.style.opacity = '0'; });
  document.addEventListener('mouseenter', () => { cursor.style.opacity = '1'; });

  // Park the lens until the pointer is actually known, so it never appears in
  // the top-left corner on load.
  let seen = false;
  document.addEventListener('mousemove', () => { seen = true; }, { passive: true, once: true });

  function loop() {
    pos.x += (target.x - pos.x) * FOLLOW;
    pos.y += (target.y - pos.y) * FOLLOW;

    const goal = Math.min(
      R_MIN + speed * SPEED_GAIN + Math.abs(accel) * ACCEL_GAIN,
      R_MAX,
    ) * (hovering ? HOVER_SCALE : 1);
    radius += (goal - radius) * (goal > radius ? OPEN : CLOSE);

    // Speed and acceleration decay every frame, which is what makes a stop at
    // rest actually shrink the lens rather than freezing it mid-size.
    speed *= 0.9;
    accel *= 0.75;

    if (seen) {
      cursor.style.width = `${(radius * 2).toFixed(2)}px`;
      cursor.style.height = `${(radius * 2).toFixed(2)}px`;
      cursor.style.transform = `translate(${(pos.x - radius).toFixed(2)}px, ${(pos.y - radius).toFixed(2)}px)`;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
