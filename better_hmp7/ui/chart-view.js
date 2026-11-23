(function (root) {
  'use strict';
  function clamp(bounds, limits, minimum = 5) {
    const total = Math.max(0, limits.end - limits.start);
    // The real data range wins when the recording has fewer than five seconds,
    // including the first single point. Never invent time beyond its bounds.
    if (total <= minimum) return { start: limits.start, end: limits.start + total };
    const span = Math.max(Math.min(minimum, total), Math.min(total, bounds.end - bounds.start));
    let start = Math.max(limits.start, Math.min(bounds.start, limits.end - span));
    return { start, end: start + span };
  }
  function zoom(bounds, anchor, factor, limits) {
    const oldSpan = bounds.end - bounds.start;
    const fraction = oldSpan > 0 ? Math.max(0, Math.min(1, (anchor - bounds.start) / oldSpan)) : 0.5;
    const span = Math.max(5, Math.min(limits.end - limits.start, oldSpan * factor));
    return clamp({ start: anchor - span * fraction, end: anchor + span * (1 - fraction) }, limits);
  }
  function pan(bounds, fraction, limits) {
    const delta = (bounds.end - bounds.start) * fraction;
    return clamp({ start: bounds.start + delta, end: bounds.end + delta }, limits);
  }
  function restore(value, keys, fallback = ['temperature', 'humidity']) {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return [...new Set(parsed.filter(k => keys.includes(k)))]; } catch (_) {}
    return fallback.filter(k => keys.includes(k));
  }
  root.HMP7ChartView = Object.freeze({ clamp, zoom, pan, restore });
})(globalThis);
