/**
 * theme.js — the one palette both the dashboard and the landing page draw from.
 * -----------------------------------------------------------------------------
 * Canvas drawing cannot read CSS custom properties, so every colour a renderer
 * needs is mirrored here. Keeping a single frozen object means the mission map,
 * the landing figures and the CSS can never drift apart again: if you change a
 * hue, you change it once, here and in the stylesheet.
 *
 * Colour discipline (deliberate, and load-bearing for reading the figures):
 *   accent / belief  ORANGE   probability mass — what the agent thinks
 *   warm / spent     AMBER    WALL-E itself, its trail, energy it burned
 *   cyan             SIGNAL   sensor readings and their Gaussian rings
 *   green            SUCCESS  contact established
 *   red              DANGER   battery depletion
 * Nothing else is coloured, so a glance at any figure tells you which layer is
 * which without a legend.
 */
export const palette = Object.freeze({
  // --- surfaces ---------------------------------------------------------
  bg: '#0a0a0a',
  space0: '#0a0a0a',
  space1: '#101014',
  surface: '#121214',
  surface2: '#1a1a1d',
  surface3: '#222226',
  surface4: '#2a2a30',
  line: 'rgba(255, 255, 255, 0.07)',
  lineStrong: 'rgba(255, 255, 255, 0.14)',
  border: 'rgba(255, 255, 255, 0.08)',

  // --- type -------------------------------------------------------------
  text: '#FFFFFF',
  textDim: 'rgba(255, 255, 255, 0.62)',
  textFaint: 'rgba(255, 255, 255, 0.4)',   // --- semantic ---------------------------------------------------------
   accent: '#d9660a',
   accentLight: '#e8895c',
   belief: '#d9660a',
   beliefRGB: '217, 102, 10',
   warm: '#d9660a',
   rust: '#d9660a',
   peak: '#e8895c',
   credible: 'rgba(232, 137, 92, 0.55)',
   cyan: '#59e3ec',
   green: '#3ddc97',
   success: '#3ddc97',
   warning: '#ffd28a',
   red: '#ff5a5a',
   error: '#ff5a5a',
   
   // --- map layers -------------------------------------------------------
   visited: 'rgba(217, 102, 10, 0.14)',
   path: '#d9660a',
   obstacleFill: '#07070a',
   obstacleEdge: 'rgba(255, 255, 255, 0.13)',
   station: '#d9660a',
   stationDead: 'rgba(255, 255, 255, 0.18)',
   clue: '#59e3ec',
   peak: '#e8895c',
   particle: 'rgba(89, 227, 236, 0.42)',
   credible: 'rgba(232, 137, 92, 0.55)',
   decoy: '#ff5a5a',
   clueRing: 'rgba(89,227,236,0.55)',
   decoyRing: 'rgba(255,90,90,0.55)',
   decoyFill: 'rgba(255,90,90,0.9)',
   eveFill: '#F4FDFF',
   peakRGB: '232,137,92',
   scanRGB: '217,102,10',
   });


/** Mission status -> colour, for the header chips and the gauges. */
export function statusColor(status, running = false) {
  switch (status) {
    case 'eve_found': return palette.green;
    case 'battery_depleted': return palette.red;
    case 'time_expired': return palette.warning;
    default: return running ? palette.accentLight : palette.textFaint;
  }
}

/**
 * Sequential colour ramp for the numeric posterior matrices.
 * Returns a CSS rgba() string for a value already normalised to 0..1.
 * Low values stay transparent so the grid reads as ink on paper rather than a
 * wall of tinted boxes.
 */
export function beliefInk(t, alpha = 1) {
  const v = Math.max(0, Math.min(1, t || 0));
  const a = (0.06 + 0.82 * Math.pow(v, 0.75)) * alpha;
  return `rgba(${palette.beliefRGB}, ${a.toFixed(3)})`;
}

/** Qualitative ramp for the likelihood matrix — a different hue, because it is
 *  evidence rather than belief, and mixing the two up is the classic mistake. */
export function likelihoodInk(t, alpha = 1) {
  const v = Math.max(0, Math.min(1, t || 0));
  const a = (0.06 + 0.78 * Math.pow(v, 0.7)) * alpha;
  return `rgba(89, 227, 236, ${a.toFixed(3)})`;
}
