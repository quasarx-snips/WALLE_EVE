/**
 * theme-toggle.js — day/night mode shared by both pages.
 * -----------------------------------------------------------------------------
 * Zero-dependency (no npm, no icon font): the sun/moon glyphs are inline Lucide
 * icons (ISC licensed, https://lucide.dev/icons/sun + /moon) baked into each
 * page's SVG sprite as #i-sun / #i-moon.
 *
 * Contract: <html data-theme="dark|light"> drives CSS tokens; the toggle button
 * [data-theme-toggle] shows the OTHER mode's glyph via CSS. Preference order:
 * saved localStorage > OS prefers-color-scheme > dark default. Saved under
 * "walle-eve-theme" so landing + mission stay in sync.
 */
const KEY = 'walle-eve-theme';

function systemTheme() {
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* ignore */ }
  return 'dark';
}

export function getTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { /* ignore */ }
  return systemTheme();
}

export function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const isLight = next === 'light';
    btn.setAttribute('aria-pressed', String(isLight));
    btn.setAttribute('aria-label', isLight ? 'Switch to night mode' : 'Switch to day mode');
    btn.title = isLight ? 'Switch to night mode' : 'Switch to day mode';
    const label = btn.querySelector('[data-theme-toggle-label]');
    if (label) label.textContent = isLight ? 'Night' : 'Day';
  });
  return next;
}

export function initThemeToggle() {
  applyTheme(getTheme());
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      applyTheme(cur === 'light' ? 'dark' : 'light');
    });
  });
  // Follow OS changes only when the user never picked explicitly.
  try {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      try {
        if (localStorage.getItem(KEY)) return;
      } catch { /* ignore */ }
      applyTheme(e.matches ? 'light' : 'dark');
    };
    if (mq && mq.addEventListener) mq.addEventListener('change', onChange);
  } catch { /* ignore */ }
}
