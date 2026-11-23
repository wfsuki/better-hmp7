import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

// Exercise the pure report helpers without starting the page, browser, file picker or serial port.
const source = fs.readFileSync(new URL('../better_hmp7/ui/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function reportTimeBounds(');
const end = source.indexOf('async function exportReport(', start);
assert(start >= 0 && end > start);
const channels = {
  temperature: { name: '温度', unit: '°C', color: '#df7f45', minimumSpan: .2 },
  humidity: { name: '相对湿度', unit: '%RH', color: '#4776dc', minimumSpan: .2 },
  dewpoint: { name: '露点', unit: '°C', color: '#209b8b', minimumSpan: .2 },
  absolute_humidity: { name: '绝对湿度', unit: 'g/m³', color: '#8b72cc', minimumSpan: .1 },
};
const context = vm.createContext({
  Intl, Date, Math, Number, Set, Array, Object,
  CHANNELS: channels, METRICS: Object.keys(channels),
  finite: Number.isFinite,
  escaped: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  numberText: (v, decimals = 2) => Number.isFinite(v) ? v.toFixed(decimals) : '—',
  dateText: (v) => Number.isFinite(v) ? new Date(v * 1000).toISOString() : '—',
  durationText: (v) => String(v), reportDeviceInfo: null, deviceInfo: null, csvName: 'test.csv',
  // Deliberately unrelated live zoom. Reports must never consult these fields.
  customBounds: { start: 9999999999, end: 9999999999.1 }, duration: .1,
  currentHistory: { points: [], stats: {} },
});
vm.runInContext(source.slice(start, end), context);
const t0 = Date.parse('2026-11-11T08:00:00Z') / 1000;
const point = (i, value = 20) => ({ ts: t0 + i, temperature: value, humidity: 40, dewpoint: 7, absolute_humidity: 8 });
const data = (points, buckets) => context.reportChartData(points, 'temperature', buckets);
const svg = (points) => context.reportChart(points, 'temperature');

test('long records preserve each time bucket extrema, endpoints and time order', () => {
  const points = Array.from({ length: 100001 }, (_, i) => point(i, 20 + Math.sin(i / 20)));
  points[17777].temperature = 88;
  points[50001].temperature = -17;
  const result = data(points, 120);
  assert.equal(result.start, points[0].ts);
  assert.equal(result.end, points.at(-1).ts);
  assert.equal(result.low, -17); assert.equal(result.high, 88);
  assert.equal(result.segments.length, 1);
  const selected = result.segments.flat();
  assert(selected.includes(points[17777])); assert(selected.includes(points[50001]));
  assert.equal(selected[0], points[0]); assert.equal(selected.at(-1), points.at(-1));
  assert(selected.length <= 480);
  for (let i = 1; i < selected.length; i++) assert(selected[i].ts >= selected[i - 1].ts);
  for (let bucket = 0; bucket < 120; bucket++) {
    const inBucket = (p) => Math.min(119, Math.floor((p.ts - result.start) / (result.end - result.start) * 120)) === bucket;
    const raw = points.filter(inBucket).map((p) => p.temperature);
    const shown = selected.filter(inBucket).map((p) => p.temperature);
    if (raw.length) { assert.equal(Math.min(...shown), Math.min(...raw)); assert.equal(Math.max(...shown), Math.max(...raw)); }
  }
});

test('single point is centered in a finite one-minute domain and appears as a dot', () => {
  const result = data([point(0, 20.37)]);
  assert.equal(result.start, result.end);
  assert.equal(result.plotEnd - result.plotStart, 60);
  assert(result.axis.min < 20.37 && result.axis.max > 20.37);
  const markup = svg([point(0, 20.37)]);
  assert(markup.includes('<circle')); assert(!/NaN|Infinity/.test(markup));
});

test('constant and zero lines have padding and nonduplicated readable nice tick labels', () => {
  for (const value of [0, -1.25, 20.37, 100]) {
    const points = Array.from({ length: 100 }, (_, i) => point(i, value));
    const result = data(points);
    assert(result.axis.max > value && result.axis.min < value);
    const labels = result.axis.ticks.map((v) => v.toFixed(result.axis.precision));
    assert.equal(new Set(labels).size, labels.length);
    assert(result.axis.ticks.length >= 4 && result.axis.ticks.length <= 9);
    assert(!/NaN|Infinity/.test(svg(points)));
  }
});

test('cross-day axes print the actual start and end dates in Beijing time', () => {
  const points = [point(0), point(1)];
  points[0].ts = Date.parse('2026-11-11T15:59:59Z') / 1000;
  points[1].ts = Date.parse('2026-11-11T16:00:01Z') / 1000;
  const markup = svg(points);
  assert.match(markup, /2026\/11\/11/); assert.match(markup, /2026\/11\/12/);
  assert.match(markup, /23:59:59/); assert.match(markup, /00:00:01/);
});

test('nulls and long unsampled intervals stay separate before aggressive reduction', () => {
  const points = Array.from({ length: 20000 }, (_, i) => point(i, i % 17));
  points[5000].temperature = null;
  points[10000].temperature = Infinity;
  for (let i = 15000; i < points.length; i++) points[i].ts += 30;
  const result = data(points, 10);
  assert.equal(result.segments.length, 4);
  for (const segment of result.segments) {
    assert(segment.every((p) => Number.isFinite(p.temperature)));
    assert(!segment.some((p) => p === points[4999]) || !segment.some((p) => p === points[5001]));
    assert(!segment.some((p) => p === points[14999]) || !segment.some((p) => p === points[15000]));
  }
  const markup = svg(points);
  assert.equal((markup.match(/<path /g) || []).length, 4);
});

test('invalid whole metric is an empty state, not a zero line', () => {
  assert.equal(data([point(0, null), point(1, NaN)]), null);
  assert.equal(svg([point(0, null)]), '<p>没有有效测量值</p>');
});

test('report summary uses every original value and is independent of live zoom', () => {
  const points = [point(0, 10), point(1, 100), point(2, 10), point(3, null)];
  const html = context.makeReport(points);
  assert.match(html, /<td>10\.00<\/td><td>40\.00<\/td><td>100\.00<\/td><td>3<\/td>/);
  assert(html.includes(new Date(points[0].ts * 1000).toISOString()));
  assert(html.includes(new Date(points.at(-1).ts * 1000).toISOString()));
  assert.equal((html.match(/完整记录曲线/g) || []).length, 4);
  context.customBounds = { start: 0, end: 1 };
  context.duration = 86400;
  assert.equal(context.makeReport(points), html);
});

test('report charts follow selected channels while statistics retain all metrics', () => {
  context.selectedChannels = new Set(['temperature', 'humidity']);
  const html = context.makeReport([point(0), point(1)]);
  assert.equal((html.match(/完整记录曲线/g) || []).length, 2);
  assert(html.includes('<td>露点</td>'));
  assert(html.includes('<td>绝对湿度</td>'));
  assert(!html.includes('露点完整记录曲线'));
  delete context.selectedChannels;
});

test('five-second sampling tolerates normal jitter but still splits actual missing intervals', () => {
  context.recordingIntervalMs = 5000;
  const points = [point(0), point(5.1), point(10.4), point(15.5), point(36), point(41.2)];
  const result = data(points);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].length, 4);
  assert.equal(result.segments[1].length, 2);
  const html = context.makeReport(points);
  assert(html.includes('采样间隔：5 秒'));
  delete context.recordingIntervalMs;
});

test('report title and nowrap print button share a header and the button vanishes for print', () => {
  const html = context.makeReport([point(0), point(1)]);
  assert.match(html, /<header class="report-header"><div class="report-heading">.*?<h1>温湿度测量记录<\/h1><\/div><button class="report-print"/);
  assert.match(html, /\.report-header\{display:flex;align-items:center;justify-content:space-between/);
  assert.match(html, /\.report-print\{flex:0 0 auto;white-space:nowrap/);
  assert.match(html, /\.report-print\{display:none!important\}/);
  assert.match(html, /\.chart\{[^}]*break-inside:avoid/);
  assert(!html.includes('class="tools"'));
  assert(html.includes('采样间隔：1 秒'));
});

test('live interval override does not change the captured report interval', () => {
  context.recordingIntervalMs = 1000;
  const points = [point(0), point(5.1), point(10.2)];
  assert.equal(context.reportChartData(points, 'temperature', 600, 5000).segments.length, 1);
  assert.equal(data(points).segments.length, 3);
  assert(context.makeReport(points).includes('采样间隔：1 秒'));
  delete context.recordingIntervalMs;
});

test('summary respects individual measurement precision', () => {
  channels.temperature.decimals = 4;
  assert(context.makeReport([point(0, 1.2345)]).includes('<td>1.2345</td><td>1.2345</td><td>1.2345</td>'));
  delete channels.temperature.decimals;
});

test('a project icon is embedded in the printable header', () => {
  const html = context.makeReport([point(0), point(1)]);
  assert(html.includes('<img alt="" src="data:image/png;base64,{{PROJECT_ICON}}"><strong>Better HMP7</strong>'));
  assert(html.includes('.report-print{display:none!important}'));
});
