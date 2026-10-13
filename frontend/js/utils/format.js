/**
 * utils/format.js — Small, pure formatting helpers shared across components.
 * Keeping these pure makes them trivial to unit-test and reuse.
 */

/** Clamp a number into [lo, hi]. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Format a probability (0..1) as a percentage string with 0 decimals, e.g. "63%". */
export const pct = (v, digits = 0) => `${(v * 100).toFixed(digits)}%`;

/** Format a possibly-null numeric signal as a fixed-decimal string, else a dash. */
export const fixed = (v, digits = 2) => (v == null ? '-' : Number(v).toFixed(digits));

/** Left-pad a step number for aligned console output, e.g. "007". */
export const padStep = (n) => String(n).padStart(3, '0');

/**
 * Title-case and de-underscore a status/action key: "battery_depleted" -> "Battery Depleted".
 * @param {string} s
 */
export const humanize = (s) =>
  String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Group a color-coded tag from an action kind, for the ActionLog.
 * @param {import('../types.js').ActionKind} action
 * @returns {{tag: string, cls: string}}
 */
export function actionTag(action) {
  if (action === 'scan') return { tag: 'SCAN', cls: 'tag-scan' };
  if (action === 'recharge') return { tag: 'RECHARGE', cls: 'tag-recharge' };
  if (action.startsWith('move')) return { tag: 'MOVE', cls: 'tag-move' };
  if (action === 'init') return { tag: 'INIT', cls: 'tag-init' };
  return { tag: action.toUpperCase(), cls: 'tag-move' };
}

/** Theme colour for the action-panel status chip. */
export const statusChipColor = (status) => {
  if (status === 'eve_found') return '#3ddc97';
  if (status === 'battery_depleted') return '#ff9a5e';
  if (status === 'time_expired') return '#f59e0b';
  return '#ff9a5e';
};

