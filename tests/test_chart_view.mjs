import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Run the same browser helper in an isolated global, without a browser or DOM.
const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../better_hmp7/ui/chart-view.js', import.meta.url), 'utf8'), context,
  { filename: 'chart-view.js' });
const C = context.HMP7ChartView;
const keys = ['temperature', 'humidity', 'dewpoint', 'absolute_humidity'];
const plainArray = value => Array.from(value);
const close = (actual, expected, message = '') => assert.ok(Math.abs(actual - expected) < 1e-6,
  `${message}: expected ${expected}, got ${actual}`);
function windowIsValid(window, limits) {
  assert.ok(Number.isFinite(window.start) && Number.isFinite(window.end), 'window endpoints must be finite');
  assert.ok(window.start >= limits.start - 1e-6, 'window must not start before available data');
  assert.ok(window.end <= limits.end + 1e-6, 'window must not end after available data');
  assert.ok(window.end >= window.start, 'window endpoints must remain ordered');
}

test('Zoom preserves the pointer anchor fraction when no data boundary is reached', () => {
  const before = { start: 20, end: 120 }, limits = { start: 0, end: 200 }, anchor = 45;
  const result = C.zoom(before, anchor, 0.5, limits);
  close(result.start, 32.5); close(result.end, 82.5);
  close((anchor-result.start)/(result.end-result.start), (anchor-before.start)/(before.end-before.start));
});

test('Zoom out doubles the span and keeps a central anchor stationary', () => {
  const result = C.zoom({ start: 100, end: 200 }, 150, 2, { start: 0, end: 400 });
  close(result.start, 50); close(result.end, 250);
});

test('Zoom factor one leaves the viewport unchanged', () => {
  const result = C.zoom({ start: 40, end: 90 }, 65, 1, { start: 0, end: 200 });
  close(result.start, 40); close(result.end, 90);
});

test('An anchor at either chart edge stays there during inward zoom', () => {
  const limits = { start: 0, end: 200 };
  const left = C.zoom({ start: 40, end: 100 }, 40, 0.5, limits);
  const right = C.zoom({ start: 40, end: 100 }, 100, 0.5, limits);
  close(left.start, 40); close(left.end, 70);
  close(right.start, 70); close(right.end, 100);
});

test('Repeated zoom-in stops at a five-second span when enough data exists', () => {
  const limits = { start: 0, end: 200 };
  let result = { start: 50, end: 150 };
  for (let n=0; n<15; n++) result = C.zoom(result, 100, 0.2, limits);
  windowIsValid(result, limits);
  close(result.end-result.start, 5);
  close((result.start+result.end)/2, 100);
});

test('Zoom-out cannot extend beyond the full data range', () => {
  const limits = { start: 30, end: 130 };
  const result = C.zoom({ start: 60, end: 80 }, 65, 100, limits);
  windowIsValid(result, limits);
  close(result.start, limits.start); close(result.end, limits.end);
});

test('Clamp translates an offscreen viewport without changing its valid span', () => {
  const limits = { start: 10, end: 110 };
  const left = C.clamp({ start: -40, end: -20 }, limits);
  const right = C.clamp({ start: 180, end: 200 }, limits);
  close(left.start, 10); close(left.end, 30);
  close(right.start, 90); close(right.end, 110);
});

test('Clamp fits an oversized viewport to the available data', () => {
  const result = C.clamp({ start: -100, end: 500 }, { start: 20, end: 80 });
  close(result.start, 20); close(result.end, 80);
});

test('Clamp never fabricates extra time when fewer than five seconds of data exist', () => {
  for (const length of [0.1, 1, 4, 4.999]) {
    const limits = { start: 100, end: 100+length };
    const result = C.clamp({ start: 100, end: 100+length }, limits);
    windowIsValid(result, limits);
    close(result.end-result.start, length);
  }
});

test('Short-series zoom and pan remain inside actual data even below the minimum zoom span', () => {
  const limits = { start: 100, end: 103 };
  for (const result of [C.zoom(limits, 101, 0.1, limits), C.pan(limits, 3, limits), C.pan(limits, -3, limits)]) {
    windowIsValid(result, limits);
    close(result.start, 100); close(result.end, 103);
  }
});

test('The first single sample yields a finite viewport rather than NaN or invented data', () => {
  const only = { start: 100, end: 100 };
  for (const result of [C.clamp(only, only), C.zoom(only, 100, 0.5, only), C.pan(only, 1, only)]) {
    windowIsValid(result, only);
    close(result.start, 100); close(result.end, 100);
  }
});

test('A zero-width viewport can recover to the minimum span inside a larger data range', () => {
  const limits = { start: 0, end: 100 };
  const result = C.zoom({ start: 40, end: 40 }, 40, 0.5, limits);
  windowIsValid(result, limits);
  close(result.end-result.start, 5);
});

test('Pan translates by a fraction of the visible span without zooming', () => {
  const limits = { start: 0, end: 300 };
  const forward = C.pan({ start: 100, end: 160 }, 0.5, limits);
  const back = C.pan({ start: 100, end: 160 }, -0.5, limits);
  close(forward.start, 130); close(forward.end, 190);
  close(back.start, 70); close(back.end, 130);
});

test('Pan at either data boundary preserves the span rather than compressing it', () => {
  const limits = { start: 20, end: 200 };
  for (const [fraction, expectedStart] of [[-100,20], [100,140]]) {
    const result = C.pan({ start: 80, end: 140 }, fraction, limits);
    windowIsValid(result, limits);
    close(result.start, expectedStart);
    close(result.end-result.start, 60);
  }
});

test('Epoch timestamps and fractional seconds preserve boundaries and span', () => {
  const base = 1794366000.125;
  const limits = { start: base, end: base+80 };
  const result = C.pan({ start: base+20, end: base+40 }, -20, limits);
  windowIsValid(result, limits);
  close(result.start, base); close(result.end-result.start, 20);
});

test('Restore retains valid stored selections in their selected order', () => {
  assert.deepEqual(plainArray(C.restore('["humidity","dewpoint"]', keys)), ['humidity','dewpoint']);
});

test('Restore uses temperature and humidity defaults for malformed or non-array JSON', () => {
  for (const value of ['{oops', '', undefined, null, 'null', 'true', '42', '"temperature"', '{"temperature":true}']) {
    assert.deepEqual(plainArray(C.restore(value, keys)), ['temperature','humidity'], String(value));
  }
});

test('An explicit empty saved selection stays empty instead of silently restoring defaults', () => {
  assert.deepEqual(plainArray(C.restore('[]', keys)), []);
});

test('Restore removes unknown or non-string keys and deduplicates valid keys', () => {
  const stored = '["unknown","humidity","humidity",12,null,{},"temperature","Temperature"]';
  assert.deepEqual(plainArray(C.restore(stored, keys)), ['humidity','temperature']);
});

test('A valid array containing only unavailable metrics resolves to an empty selection', () => {
  assert.deepEqual(plainArray(C.restore('["old-metric","unknown"]', keys)), []);
});

test('Fallback selections are limited to currently available metric keys', () => {
  assert.deepEqual(plainArray(C.restore('broken', ['humidity','dewpoint'])), ['humidity']);
  assert.deepEqual(plainArray(C.restore('broken', keys, ['dewpoint','unknown'])), ['dewpoint']);
});

test('Viewport and preference helpers do not mutate the caller inputs', () => {
  const bounds = { start: 20, end: 80 }, limits = { start: 0, end: 200 };
  const beforeBounds = { ...bounds }, beforeLimits = { ...limits }, originalKeys = [...keys];
  C.zoom(bounds, 40, 0.5, limits); C.pan(bounds, 0.2, limits); C.clamp(bounds, limits);
  C.restore('["humidity","humidity","dewpoint"]', keys);
  assert.deepEqual(bounds, beforeBounds); assert.deepEqual(limits, beforeLimits); assert.deepEqual(keys, originalKeys);
});
