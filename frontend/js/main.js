/**
 * main.js — ES-module entry point.
 * -------------------------------------------------------------------------
 * The browser loads this as `type="module"`, and all `import` statements resolve
 * natively (Flask serves them with a correct JS MIME type — see app.py). No
 * bundler, no build step. We just bootstrap the App once the DOM is ready.
 */
import { App } from './App.js';
import { initThemeToggle } from './theme-toggle.js';

function boot() {
  initThemeToggle();
  const root = document.getElementById('app');
  const app = new App(root);
  // Expose for debugging in the console (window.__walle); harmless in prod.
  window.__walle = app;
  app.reset();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
