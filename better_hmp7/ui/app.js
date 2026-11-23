'use strict';
const $ = (id) => document.getElementById(id);
const CHANNELS = Object.fromEntries(HMP7Metrics.measurements.map(m => [m.key, m]));
const METRICS = Object.keys(CHANNELS);
const selectedChannels = new Set(['temperature', 'humidity']);
let samplingIntervalMs = 1000, recordingIntervalMs = 1000, preferencesLoaded = false;
function saveSettings() {
  if (preferencesLoaded) HMP7Desktop.savePreferences(selectedChannels, samplingIntervalMs)
    .catch(() => toast('本机设置未能保存，本次选择仍有效。'));
}
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const text = (id, value) => { $(id).textContent = value; };
const numberText = (v, digits = 2) => finite(v) ? v.toFixed(digits) : '—';
const serverTime = () => Date.now() / 1000;
let currentState = { latest: null, count: 0 };
let currentHistory = null, channel = 'temperature', duration = 900, customBounds = null;
let chartGeometry = null, toastTimer, deviceInfo = null, selectedCsvHandle = null, csvHandle = null;
let previewPoints = [], recordedPoints = [], events = [], recording = false, connectionBusy = false;
let fileBusy = false, sampling = false, pageClosing = false, sampleTimer = null, chartTick = 0;
let pickerBusy = false, pickerKind = '';

let recordingStarted = null, recordingStopped = null, recordingGeneration = 0, csvName = '', latestError = '';
let writeChain = Promise.resolve(), reportDeviceInfo = null;
let dragState = null, chartFrame = 0, parameterSnapshot = {}, unavailableParameters = {};
const activeRecording = () => recording;

function dateText(value, options = {}) {
  if (!finite(value)) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', ...options }).format(new Date(value * 1000));
}
function showingRecording() {
  return recording || (recordedPoints.length > 0 && (!HMP7Serial.connected || document.body.classList.contains('history-view')));
}
function chartPoints() { return showingRecording() ? recordedPoints : previewPoints; }
function rangeBounds() { const end = showingRecording() && !recording && recordedPoints.length ? recordedPoints.at(-1).ts + 1 : serverTime(); return customBounds || { start: end - duration, end }; }
function availableBounds() {
  const points = chartPoints();
  const end = Math.max(points.at(-1)?.ts || serverTime(), recording || !showingRecording() ? serverTime() : 0) + 1;
  return { start: Math.min(points[0]?.ts || end - 60, end - 60) - 1, end };
}
function syncCurveControls() {
  document.querySelectorAll('[data-curve]').forEach(el => { el.checked = selectedChannels.has(el.dataset.curve); });
  document.querySelectorAll('[data-metric]').forEach(el => { const selected = selectedChannels.has(el.dataset.metric); el.classList.toggle('selected', selected); el.setAttribute('aria-pressed', String(selected)); });
  $('reset-view').hidden = !customBounds;
  text('curve-count', `已选 ${selectedChannels.size} 条`);
}
function toggleChannel(key) {
  if (!CHANNELS[key]) return;
  if (selectedChannels.has(key)) selectedChannels.delete(key); else selectedChannels.add(key);
  channel = [...selectedChannels][0] || 'temperature';
  saveSettings();
  syncCurveControls(); renderHistory();
}
function initializeMetrics() {
  const grid = $('metric-grid'), choices = $('curve-options');
  for (const key of METRICS) {
    const m = CHANNELS[key], button = document.createElement('button');
    button.type = 'button'; button.className = 'metric'; button.dataset.metric = key; button.style.setProperty('--channel', m.color); button.title = m.description || m.name;
    button.innerHTML = `<div class="metric-top"><span>${escaped(m.name)}</span><span class="metric-tick" aria-hidden="true">✓</span></div><div class="reading"><strong id="value-${key}">—</strong><span>${escaped(m.unit)}</span></div><div class="metric-bottom"><span id="range-${key}">等待读数</span><svg class="sparkline" id="spark-${key}" viewBox="0 0 100 28" aria-hidden="true"></svg></div>`;
    button.addEventListener('click', () => toggleChannel(key)); grid.append(button);
    const label = document.createElement('label'); label.className = 'curve-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.curve = key; input.addEventListener('change', () => toggleChannel(key));
    const dot = document.createElement('i'); dot.style.background = m.color;
    const name = document.createElement('span'); name.textContent = `${m.name} (${m.unit})`; label.append(input, dot, name); choices.append(label);
  }
  for (const meta of HMP7Metrics.parameters || []) {
    const row = document.createElement('div'); row.className = 'parameter-item'; row.title = meta.description || '';
    const term = document.createElement('dt'), value = document.createElement('dd'); term.textContent = meta.name; value.id = `parameter-${meta.key}`; value.textContent = '—'; row.append(term, value); $('probe-parameters').append(row);
  }
  syncCurveControls();
}
function renderParameters() {
  for (const meta of HMP7Metrics.parameters || []) {
    const value = parameterSnapshot[meta.key], target = $(`parameter-${meta.key}`);
    if (!target) continue;
    const unavailable = unavailableParameters[meta.key];
    target.textContent = unavailable ? '暂不可用' : HMP7Metrics.formatValue ? HMP7Metrics.formatValue(meta.key, value) : value === null || value === undefined ? '—' : meta.values && meta.values[value] !== undefined ? meta.values[value] : typeof value === 'boolean' ? value ? '是' : '否' : typeof value === 'number' ? `${numberText(value, meta.decimals ?? 2)}${meta.unit ? ` ${meta.unit}` : ''}` : String(value);
    target.title = unavailable || meta.description || '';
    if(!unavailable && value !== null && value !== undefined && meta.unit && HMP7Metrics.formatValue) target.textContent += ` ${meta.unit}`;
  }
}
function toast(message) { text('toast', message); $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5500); }
function notice(message) { $('notice').hidden = !message; text('notice-text', message || ''); $('retry-button').hidden = true; }
function durationText(value) { const n = Math.max(0, Math.floor(value)); return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map((x) => String(x).padStart(2, '0')).join(':'); }
function addEvent(message) {
  events.unshift({ message, ts: serverTime() }); events = events.slice(0, 10);
  $('events').replaceChildren(...events.map((event) => { const li = document.createElement('li'), span = document.createElement('span'), time = document.createElement('time'); span.textContent = event.message; time.textContent = dateText(event.ts); li.append(span, time); return li; }));
}

function renderStatus() {
  const connected = Boolean(window.HMP7Serial?.connected), latest = currentState.latest;
  const fresh = connected && latest && serverTime() - latest.ts < 6;
  text('server-label', connected ? '本机探头已连接' : '本机探头未连接');
  $('server-dot').className = `status-dot ${connected ? 'good' : ''}`;
  $('live-pill').className = `live-pill ${fresh ? '' : latest ? 'stale' : 'waiting'}`;
  text('live-label', fresh ? recording ? '记录中' : '实时预览' : connected ? '等待读数' : '未连接');
  text('updated-label', latest ? `${fresh ? '更新于' : '最后读数'} ${dateText(latest.ts)} · 北京时间` : '等待读取本机探头');
  for (const key of METRICS) {
    text(`value-${key}`, numberText(latest?.[key], CHANNELS[key].decimals ?? 2));
    const card = $(`value-${key}`).closest('.metric');
    card.classList.toggle('unavailable', Boolean(connected && latest && !finite(latest[key])));
    card.title = unavailableParameters[key] || CHANNELS[key].description || CHANNELS[key].name;
  }
  renderParameters();
  document.querySelectorAll('.metric').forEach((el) => el.classList.toggle('is-stale', Boolean(latest && !fresh)));
  text('device-state', connected ? '本机已连接' : '未连接'); $('device-state').className = `tag ${connected ? 'connected' : 'neutral'}`;
  text('source-name', '当前这台电脑'); text('source-port', connected ? `${deviceInfo?.port || 'USB 串口'} · 19200` : '—');
  text('source-cable', deviceInfo ? `${deviceInfo.usbVendorId?.toString(16).padStart(4, '0').toUpperCase() || '—'}:${deviceInfo.usbProductId?.toString(16).padStart(4, '0').toUpperCase() || '—'}` : '—');
  text('source-firmware', deviceInfo?.firmware || '—'); text('record-count', `${recordedPoints.length.toLocaleString('zh-CN')} 条`);
  text('first-record', recordingStarted ? dateText(recordingStarted, { month: '2-digit', day: '2-digit' }) : '—');
  text('device-short', deviceInfo?.model || 'HMP7');
  text('storage-path', selectedCsvHandle ? `待记录文件：${selectedCsvHandle.name}` : csvName ? `记录文件：${csvName}` : '保存文件：尚未选择');
  text('connect-button-label', connectionBusy ? '连接中…' : connected ? '断开探头' : '连接探头');
  $('connect-button').disabled = connectionBusy || !preferencesLoaded; $('dialog-connect-button').disabled = connectionBusy || connected;
  $('folder-button').disabled = recording || fileBusy || pickerBusy;
  text('folder-button', pickerKind === 'recording-file' ? '正在选择文件…' : selectedCsvHandle ? '更换保存文件' : '选择保存文件');
  $('folder-button').setAttribute('aria-busy', String(pickerKind === 'recording-file'));
  $('export-button').disabled = !recordedPoints.length || fileBusy || pickerBusy;
  $('export-csv-button').disabled = !recordedPoints.length || fileBusy || pickerBusy;
  $('export-button').setAttribute('aria-busy', String(pickerKind === 'report'));
  $('export-csv-button').setAttribute('aria-busy', String(pickerKind === 'csv'));
  $('setup-connection').lastChild.textContent = connected ? '本机探头已连接，可关闭此说明并开始测量。' : '等待连接本机探头';
  $('setup-connection').firstChild.className = `status-dot ${connected ? 'good' : ''}`;
  notice(latestError);
  renderRecording();
}
function renderRecording() {
  $('recording-bar').className = `recording-bar ${recording ? 'is-recording' : ''}`;
  text('recording-title', recording ? '正在记录 · 保存到本机' : recordedPoints.length ? '记录已保存 · 实时预览' : '实时预览 · 未保存');
  text('recording-description', recording ? `保存至 ${csvName}` : selectedCsvHandle ? `待记录文件：${selectedCsvHandle.name}` : recordedPoints.length ? `已保存 ${recordedPoints.length.toLocaleString('zh-CN')} 条 · ${csvName}` : '开始记录时选择一个新的 CSV 文件');
  $('recording-duration').hidden = !recording;
  text('recording-duration', recording ? durationText(serverTime() - recordingStarted) : '00:00:00');
  text('recording-button-label', pickerKind === 'recording-file' ? '正在选择文件…' : fileBusy ? '正在准备…' : recording ? '停止记录' : '开始记录');
  $('recording-button').classList.toggle('stop-recording', recording);
  $('recording-button').disabled = fileBusy || pickerBusy || pageClosing || (!recording && !window.HMP7Serial?.connected);
  $('sampling-interval').disabled = recording || fileBusy || pickerBusy;
  $('chart-follow').hidden = Boolean(customBounds);
  $('chart-follow').classList.toggle('not-recording', !recording);
  $('chart-follow').lastChild.textContent = recording ? '记录中' : showingRecording() ? '本次记录' : '实时预览';
}
async function nativePicker(kind, options) {
  if (pickerBusy) throw new Error('请先完成已打开的文件选择窗口。');
  pickerBusy = true;
  pickerKind = kind;
  renderStatus();
  try { return await HMP7Desktop.chooseFile(kind, options); }
  finally { pickerBusy = false; pickerKind = ''; renderStatus(); }
}
function pickerError(error, action) {
  if (error.name === 'AbortError') return;
  const message = action + '失败：' + error.message;
  addEvent(message);
  toast(message);
}
function recordingFileOptions() {
  return { id: 'hmp7-recordings', startIn: 'desktop', suggestedName: `HMP7-${fileStamp()}.csv`,
    types: [{ description: 'CSV 原始测量数据', accept: { 'text/csv': ['.csv'] } }] };
}
async function chooseRecordingFile(event) {
  if (recording || fileBusy || pickerBusy) return;
  try {
    // Choosing a file does not open a writable stream or modify its existing contents.
    selectedCsvHandle = await nativePicker('recording-file', recordingFileOptions(), event);
    addEvent(`已选择待记录文件：${selectedCsvHandle.name}`); toast(`已选择 ${selectedCsvHandle.name}，点击“开始记录”才会写入。`);
  } catch (error) { pickerError(error, '选择保存文件'); }
  finally { renderStatus(); }
}
function fileStamp() { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}-${String(d.getMilliseconds()).padStart(3,'0')}`; }
function csvRow(point) { return `${new Date(point.ts * 1000).toISOString()},${dateText(point.ts, { year:'numeric',month:'2-digit',day:'2-digit' })},${METRICS.map((m) => finite(point[m]) ? String(point[m]) : '').join(',')}\r\n`; }
const CSV_HEADER = '\ufeff采样时间(UTC),采样时间(北京时间),' + METRICS.map(key => `${CHANNELS[key].name}(${CHANNELS[key].unit})`).join(',') + '\r\n';
async function writeComplete(handle, content) {
  await HMP7Desktop.writeFile(handle, content);
}
async function startRecording(event) {
  if (recording || fileBusy || pickerBusy || !window.HMP7Serial?.connected) return;
  try {
    fileBusy = true;
    // A completed recording handle is never silently reused. Each new session uses a newly
    // selected file, or opens a new native save dialog with a unique suggested filename.
    let handle = selectedCsvHandle;
    if (!handle) handle = await nativePicker('recording-file', recordingFileOptions(), event);
    selectedCsvHandle = null;
    renderStatus(); await writeChain;
    if (pageClosing || !HMP7Serial.connected) throw new Error('探头已断开，本次记录没有开始');
    await writeComplete(handle, CSV_HEADER);
    if (pageClosing || !HMP7Serial.connected) {
      await (await HMP7Desktop.ready).end_csv(handle.token);
      throw new Error('探头已断开，本次记录没有开始');
    }
    csvHandle = handle; csvName = handle.name; selectedCsvHandle = null; recordedPoints = []; reportDeviceInfo = { ...deviceInfo };
    recordingIntervalMs = samplingIntervalMs; customBounds = null;
    recordingStarted = serverTime(); recordingStopped = null; recordingGeneration++; recording = true; latestError = '';
    addEvent(`开始记录，保存到 ${csvName}`); toast('已开始逐次保存 CSV。关闭窗口即停止。'); rebuildHistory();
  } catch (error) { pickerError(error, '开始记录'); }
  finally { fileBusy = false; renderStatus(); }
}
async function stopRecording(silent = false) {
  if (!recording) return;
  recording = false; recordingStopped = serverTime(); recordingGeneration++;
  const handle = csvHandle;
  const closing = writeChain.then(async () => (await HMP7Desktop.ready).end_csv(handle.token));
  writeChain = closing.catch(() => {});
  renderStatus();
  try { await closing; } catch (error) { pickerError(error, '关闭记录'); }
  if (!silent) { addEvent(`停止记录，已保存 ${recordedPoints.length} 条`); toast('记录已停止，CSV 已保存在本机。可导出本次测量报告。'); }
  rebuildHistory(); renderStatus();
}
async function appendSample(point) {
  const handle = csvHandle;
  const job = writeChain.then(async () => {
    await (await HMP7Desktop.ready).append_csv(handle.token, csvRow(point));
    recordedPoints.push(point); currentState.count = recordedPoints.length;
  });
  writeChain = job.catch(() => {});
  try { await job; }
  catch (error) { await stopRecording(true); latestError = `写入失败，已停止记录：${error.message}。请检查文件写入权限和磁盘空间。`; addEvent('本机文件写入失败，记录停止'); toast(latestError); }
}
async function connectProbe() {
  if (connectionBusy) return;
  if (HMP7Serial.connected) { await stopRecording(true); await HMP7Serial.disconnect(); renderStatus(); return; }
  connectionBusy = true; latestError = ''; renderStatus();
  try {
    deviceInfo = await HMP7Serial.connect();
    currentState.latest = null; previewPoints = [];
    addEvent(`已连接本机 ${deviceInfo.model} 探头`);
    if ($('setup-dialog').open) $('setup-dialog').close();
    sampleLoop();
  } catch (error) { if (error.name !== 'NotFoundError' && error.name !== 'AbortError') { latestError = error.message || '未能连接探头'; addEvent(latestError); } }
  finally { connectionBusy = false; renderStatus(); }
}
async function sampleLoop() {
  if (sampling || pageClosing || !HMP7Serial.connected) return;
  sampling = true; const started = performance.now(), generation = recordingGeneration, wasRecording = recording;
  try {
    const sample = await HMP7Serial.sample();
    if (pageClosing) return;
    parameterSnapshot = sample.parameters || {};
    unavailableParameters = sample.unavailable || {};
    const point = { ts: sample.timestamp, ...Object.fromEntries(METRICS.map((m) => [m, finite(sample[m]) ? sample[m] : null])) };
    currentState.latest = point; previewPoints.push(point);
    previewPoints = previewPoints.filter((p) => p.ts >= point.ts - 1800);
    if (wasRecording && recording && generation === recordingGeneration) await appendSample(point);
    latestError = sample.warnings?.length ? sample.warnings.join('；') : latestError.startsWith('写入失败') ? latestError : '';
    if (++chartTick % 2 === 0 || !currentHistory) rebuildHistory();
  } catch (error) {
    latestError = `读取失败：${error.message}`;
    if (recording) await stopRecording(true);
    addEvent(latestError);
  } finally {
    sampling = false; renderStatus();
    if (!pageClosing && HMP7Serial.connected) sampleTimer = setTimeout(sampleLoop, Math.max(10, samplingIntervalMs - (performance.now() - started)));
  }
}
function rebuildHistory() {
  const input = chartPoints();
  const requested = rangeBounds(), b = customBounds || { start: Math.max(requested.start, Math.min(input[0]?.ts - 1 || requested.start, requested.end - 60)), end: requested.end };
  const rows = input.filter((p) => p.ts >= b.start && p.ts <= b.end), stats = {};
  for (const m of METRICS) { const values = rows.map((p) => p[m]).filter(finite); stats[m] = { min: values.length ? values.reduce((a,v)=>Math.min(a,v), Infinity) : null, max: values.length ? values.reduce((a,v)=>Math.max(a,v),-Infinity) : null, mean: values.length ? values.reduce((a,v)=>a+v,0)/values.length : null, count: values.length }; }
  // Keep every recorded sample in the CSV. The screen uses a bounded set of real points.
  // Each plotted channel keeps its own extrema; never stride-sample away a peak.
  currentHistory = { points: rows, stats, recent: rows.slice(-40).reverse(), bucket: 1, start:b.start, end:b.end };
  renderHistory();
}
function setChannel(key) {
  toggleChannel(key);
}


const SVG_NS = 'http://www.w3.org/2000/svg';
function svgElement(tag, attrs = {}, content = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (content !== null) el.textContent = content;
  return el;
}

function lineSegments(points, metric, x, y, gap) {
  const result = []; let section = []; let previousTime = null;
  for (const p of points) {
    if (!finite(p[metric]) || (previousTime !== null && p.ts - previousTime > gap)) {
      if (section.length) result.push(section);
      section = [];
    }
    if (finite(p[metric])) section.push([x(p.ts), y(p[metric])]);
    previousTime = p.ts;
  }
  if (section.length) result.push(section);
  return result;
}

function pathFor(points) {
  return points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(' ');
}

function renderSparklines() {
  const points = currentHistory?.points || [];
  for (const [key, options] of Object.entries(CHANNELS)) {
    const target = $(`spark-${key}`); target.replaceChildren();
    const valid = points.filter((p) => finite(p[key]));
    if (valid.length < 2) continue;
    let min = valid.reduce((a,p) => Math.min(a,p[key]),Infinity), max = valid.reduce((a,p) => Math.max(a,p[key]),-Infinity);
    const span = Math.max(max - min, options.minimumSpan / 3);
    const mid = (min + max) / 2; min = mid - span / 2; max = mid + span / 2;
    const first = valid[0].ts, last = valid.at(-1).ts;
    const x = (t) => 1 + (t - first) / Math.max(last - first, 1) * 98;
    const y = (v) => 25 - (v - min) / (max - min) * 22;
    for (const segment of lineSegments(points, key, x, y, Math.max(4, (currentHistory?.bucket || 1) * 2.5))) {
      target.append(svgElement('path', { d: pathFor(segment), fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    }
  }
}

function renderChart() {
  const svg = $('main-chart'), chosen = [...selectedChannels];
  svg.replaceChildren(); chartGeometry = null; $('chart-tooltip').hidden = true;
  const width = Math.max(svg.clientWidth, 260), laneH = width < 500 ? 185 : 195;
  const height = Math.max(260, chosen.length * laneH + 48);
  $('chart-area').style.height = `${height}px`;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('aria-label', chosen.map(key => `${CHANNELS[key].name} (${CHANNELS[key].unit})`).join('、') || '请选择曲线');
  const left = width < 500 ? 70 : 88, right = 20, plotW = width - left - right;
  const points = currentHistory?.points || [], bounds = currentHistory || rangeBounds();
  const start = bounds.start, end = Math.max(bounds.end, start + 1);
  const x = time => left + (time - start) / (end - start) * plotW;
  const empty = $('chart-empty'); empty.hidden = chosen.length > 0;
  if (!chosen.length) { empty.querySelector('strong').textContent = '选择要显示的曲线'; empty.querySelector('p').textContent = '点击上方“选择曲线”或参数卡片'; return; }
  const defs = svgElement('defs'); svg.append(defs);
  chosen.forEach((metric, index) => {
    const c = CHANNELS[metric], laneTop = index * laneH, top = laneTop + 34, plotH = laneH - 53;
    const data = reportChartData(points, metric, 600, showingRecording() ? recordingIntervalMs : samplingIntervalMs), axis = data?.axis;
    svg.append(svgElement('text', {x: left, y: laneTop + 19, class: 'lane-title', fill: c.color}, `${c.name} · ${c.unit}`));
    const clip = svgElement('clipPath', {id: `clip-${metric}`}); clip.append(svgElement('rect', {x:left,y:top,width:plotW,height:plotH})); defs.append(clip);
    if (!axis) {
      for(let i=0;i<4;i++) svg.append(svgElement('line',{x1:left,x2:width-right,y1:top+i*plotH/3,y2:top+i*plotH/3,stroke:'#eaf0f6'}));
      svg.append(svgElement('text', {x:left+plotW/2,y:top+plotH/2,'text-anchor':'middle'}, unavailableParameters[metric] ? '此参数暂不可用' : points.length ? '此时段没有有效读数' : '等待读数'));
      return;
    }
    const y = value => top + (axis.max - value) / (axis.max - axis.min) * plotH;
    for(const value of axis.ticks) {
      const py = y(value);
      svg.append(svgElement('line',{x1:left,x2:width-right,y1:py,y2:py,stroke:'#eaf0f6'}));
      svg.append(svgElement('text',{x:left-10,y:py+5,'text-anchor':'end'},value.toFixed(axis.precision)));
    }
    const group=svgElement('g', {'clip-path':`url(#clip-${metric})`});
    for(const segment of data.segments) {
      const vertices=segment.map(point=>[x(point.ts),y(point[metric])]);
      group.append(svgElement('path',{d:pathFor(vertices),fill:'none',stroke:c.color,'stroke-width':1.8,'stroke-linejoin':'round','stroke-linecap':'round'}));
      if(vertices.length===1)group.append(svgElement('circle',{cx:vertices[0][0],cy:vertices[0][1],r:2.5,fill:c.color}));
    }
    svg.append(group);
  });
  const ticks = width < 450 ? 3 : 5;
  for(let i=0;i<ticks;i++) {
    const time=start+(end-start)*i/(ticks-1), format=end-start>86400?{month:'2-digit',day:'2-digit',second:undefined}:{second:end-start<=300?'2-digit':undefined};
    svg.append(svgElement('text',{x:x(time),y:height-12,'text-anchor':i===0?'start':i===ticks-1?'end':'middle'},dateText(time,format)));
  }
  svg.append(svgElement('line',{id:'hover-line',x1:0,x2:0,y1:30,y2:height-42,stroke:'#8b9db9','stroke-dasharray':'3 4',visibility:'hidden'}));
  chartGeometry = {start,end,left,plotW,points,x};
  syncCurveControls();
}
function scheduleChartUpdate() {
  if (chartFrame) return;
  chartFrame = requestAnimationFrame(() => { chartFrame = 0; rebuildHistory(); renderRecording(); syncCurveControls(); });
}
function freezeViewport(bounds) {
  customBounds = bounds;
  document.querySelectorAll('[data-duration]').forEach(el => {el.classList.remove('selected');el.setAttribute('aria-pressed','false');});
  $('custom-range').classList.remove('selected'); $('custom-range').setAttribute('aria-pressed','false');
  scheduleChartUpdate();
}
function resetViewport() {
  customBounds = null;
  document.querySelectorAll('[data-duration]').forEach(el => {const active=Number(el.dataset.duration)===duration;el.classList.toggle('selected',active);el.setAttribute('aria-pressed',String(active));});
  $('date-range').hidden = !document.body.classList.contains('history-view');
  rebuildHistory(); renderRecording(); syncCurveControls();
}

function statValue(id, value, unit = '') {
  const el = $(id); el.replaceChildren(document.createTextNode(value));
  if (unit && value !== '—') { const small = document.createElement('small'); small.textContent = unit; el.append(small); }
}

function renderStats() {
  channel = [...selectedChannels][0] || 'temperature';
  text('stats-caption', `${CHANNELS[channel].name} · 当前视图`);
  const stats = currentHistory?.stats[channel];
  for (const type of ['min', 'max', 'mean']) statValue(`stat-${type}`, numberText(stats?.[type]), CHANNELS[channel].unit);
  statValue('stat-count', stats?.count ? stats.count.toLocaleString('zh-CN') : '—', '条');
  for (const key of Object.keys(CHANNELS)) {
    const item = currentHistory?.stats[key];
    text(`range-${key}`, item?.count ? `${numberText(item.min, CHANNELS[key].decimals ?? 2)} – ${numberText(item.max, CHANNELS[key].decimals ?? 2)}` : unavailableParameters[key] ? '暂不可用' : '暂无有效读数');
  }
}

function renderHistory() {
  renderChart(); renderSparklines(); renderStats();
  text('chart-note', showingRecording() ? '本次记录曲线 · CSV 保留原始采样精度' : '本页实时预览 · 最近 30 分钟，仅在内存中，尚未保存');
  text('chart-period', currentHistory ? `${dateText(currentHistory.start, { second: undefined })} — ${dateText(currentHistory.end, { second: undefined })} 北京时间` : '');
  const rows = currentHistory?.recent || [];
  const shown = [...selectedChannels];
  $('records-head').replaceChildren(...['采样时间', ...shown.map(key => `${CHANNELS[key].name} (${CHANNELS[key].unit})`)].map(label => {const th = document.createElement('th'); th.textContent = label; return th;}));
  const body = $('records-body'); body.replaceChildren();
  if (!rows.length) {
    const tr = document.createElement('tr'), td = document.createElement('td');
    td.colSpan = shown.length + 1; td.className = 'empty-cell'; td.textContent = '所选时段内没有采样记录'; tr.append(td); body.append(tr); return;
  }
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of [dateText(row.ts, { month: '2-digit', day: '2-digit' }), ...shown.map((key) => numberText(row[key], CHANNELS[key].decimals ?? 2))]) {
      const td = document.createElement('td'); td.textContent = value; tr.append(td);
    }
    body.append(tr);
  }
}


function switchView(history) {
  document.body.classList.toggle('history-view', history);
  $('nav-live').classList.toggle('selected', !history); $('nav-history').classList.toggle('selected', history);
  text('page-title', history ? '本次测量数据' : '温湿度监测'); text('breadcrumb-page', history ? '本次数据' : '实时监测');

  customBounds = null;
  $('date-range').hidden = !history; rebuildHistory(); renderRecording();
}
function localDateInput(seconds) { const d = new Date(seconds*1000); return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
function escaped(value) { return String(value ?? '').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function reportTimeBounds(points) {
  let start = Infinity, end = -Infinity;
  for (const point of points) if (finite(point?.ts)) { start = Math.min(start, point.ts); end = Math.max(end, point.ts); }
  if (!finite(start) || !finite(end)) return null;
  return { start, end, plotStart: start === end ? start - 30 : start, plotEnd: start === end ? end + 30 : end };
}
function reportValueAxis(low, high, minimumSpan) {
  const span = Math.max(high - low, minimumSpan);
  const center = (low + high) / 2;
  const paddedLow = center - span * .6, paddedHigh = center + span * .6;
  const rawStep = (paddedHigh - paddedLow) / 5;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const factor = [1, 2, 2.5, 5, 10].find((value) => value * power >= rawStep);
  const step = factor * power;
  const min = Math.floor(paddedLow / step) * step, max = Math.ceil(paddedHigh / step) * step;
  let precision = Math.max(0, -Math.floor(Math.log10(step)));
  while (precision < 8 && Math.abs(Number(step.toFixed(precision)) - step) > step * 1e-8) precision++;
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => {
    const value = min + index * step;
    return Math.abs(value) < step * 1e-8 ? 0 : value;
  });
  return { min, max, step, precision, ticks };
}
function reportChartData(points, metric, bucketCount = 600, intervalMsOverride) {
  const bounds = reportTimeBounds(points);
  if (!bounds) return null;
  const intervalMs = finite(intervalMsOverride) && intervalMsOverride > 0 ? intervalMsOverride : typeof recordingIntervalMs !== 'undefined' && finite(recordingIntervalMs) && recordingIntervalMs > 0 ? recordingIntervalMs : 1000;
  const gapSeconds = Math.max(2.5 * intervalMs / 1000, 3);
  let low = Infinity, high = -Infinity, previous = null, segment = [];
  const rawSegments = [];
  const finish = () => { if (segment.length) rawSegments.push(segment); segment = []; };
  for (const point of points) {
    if (!finite(point?.ts) || !finite(point?.[metric])) { finish(); previous = null; continue; }
    // Split before reduction: neither a missing value nor an unobserved interval may disappear.
    if (previous !== null && (point.ts < previous || point.ts - previous > gapSeconds)) finish();
    segment.push(point); previous = point.ts;
    low = Math.min(low, point[metric]); high = Math.max(high, point[metric]);
  }
  finish();
  if (!rawSegments.length) return null;
  const count = Math.max(1, Math.floor(bucketCount));
  const width = Math.max(bounds.end - bounds.start, 1);
  const bucketFor = (point) => Math.min(count - 1, Math.floor((point.ts - bounds.start) / width * count));
  const segments = rawSegments.map((source) => {
    const reduced = []; let first = 0, minIndex = 0, maxIndex = 0, bucket = bucketFor(source[0]);
    const flush = (last) => {
      for (const index of [...new Set([first, minIndex, maxIndex, last])].sort((a, b) => a - b)) reduced.push(source[index]);
    };
    for (let index = 1; index < source.length; index++) {
      const next = bucketFor(source[index]);
      if (next !== bucket) { flush(index - 1); first = minIndex = maxIndex = index; bucket = next; }
      else {
        if (source[index][metric] < source[minIndex][metric]) minIndex = index;
        if (source[index][metric] > source[maxIndex][metric]) maxIndex = index;
      }
    }
    flush(source.length - 1);
    return reduced;
  });
  const configuredSpan = CHANNELS[metric].minimumSpan;
  const minimumSpan = finite(configuredSpan) && configuredSpan > 0 ? configuredSpan : Math.max(Math.abs(low) * .005, .01);
  return { ...bounds, low, high, axis: reportValueAxis(low, high, minimumSpan), segments };
}
function reportChart(points, metric) {
  const data = reportChartData(points, metric);
  if (!data) return '<p>没有有效测量值</p>';
  const c = CHANNELS[metric], width = 850, height = 270, left = 76, right = 24, top = 29, bottom = 57;
  const x = (time) => left + (time - data.plotStart) / (data.plotEnd - data.plotStart) * (width - left - right);
  const y = (value) => top + (data.axis.max - value) / (data.axis.max - data.axis.min) * (height - top - bottom);
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  const crossDay = dateFormat.format(new Date(data.plotStart * 1000)) !== dateFormat.format(new Date(data.plotEnd * 1000));
  const tickTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${c.name}完整记录曲线" xmlns="http://www.w3.org/2000/svg"><g font-family="Arial,Microsoft YaHei,sans-serif" font-size="16" fill="#53657d">`;
  for (const value of data.axis.ticks) {
    const py = y(value);
    svg += `<line x1="${left}" x2="${width - right}" y1="${py}" y2="${py}" stroke="#e4e9f0"/><text x="${left - 10}" y="${py + 5}" text-anchor="end">${value.toFixed(data.axis.precision)}</text>`;
  }
  for (let index = 0; index < 4; index++) {
    const time = data.plotStart + (data.plotEnd - data.plotStart) * index / 3, date = new Date(time * 1000);
    const anchor = index === 0 ? 'start' : index === 3 ? 'end' : 'middle';
    svg += `<text x="${x(time)}" y="${height - (crossDay ? 30 : 18)}" text-anchor="${anchor}">${escaped(tickTime.format(date))}</text>`;
    if (crossDay) svg += `<text x="${x(time)}" y="${height - 9}" text-anchor="${anchor}" font-size="14">${escaped(dateFormat.format(date))}</text>`;
  }
  svg += `<text x="${left}" y="18">${c.unit}</text></g>`;
  for (const segment of data.segments) {
    const vertices = segment.map((point) => [x(point.ts), y(point[metric])]);
    const path = vertices.map((point, index) => `${index ? 'L' : 'M'}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(' ');
    svg += `<path d="${path}" fill="none" stroke="${c.color}" stroke-width="2" stroke-linejoin="round"/>`;
    if (vertices.length === 1) svg += `<circle cx="${vertices[0][0]}" cy="${vertices[0][1]}" r="3" fill="${c.color}"/>`;
  }
  return svg + '</svg>';
}
function makeReport(points) {
  const info=reportDeviceInfo||deviceInfo||{},bounds=reportTimeBounds(points),start=bounds?.start,end=bounds?.end;
  const reportLogo = 'data:image/png;base64,{{PROJECT_ICON}}';
  const intervalSeconds = (typeof recordingIntervalMs !== 'undefined' && finite(recordingIntervalMs) && recordingIntervalMs > 0 ? recordingIntervalMs : 1000) / 1000;
  const reportMetrics = (typeof selectedChannels === 'undefined' ? METRICS : Array.from(selectedChannels)).filter((metric) => CHANNELS[metric]);
  const rows=METRICS.map((key)=>{const values=points.map((p)=>p[key]).filter(finite);const count=values.length,decimals=CHANNELS[key].decimals??2;return `<tr><td>${escaped(CHANNELS[key].name)}</td><td>${escaped(CHANNELS[key].unit)}</td><td>${numberText(count?values.reduce((a,v)=>Math.min(a,v),Infinity):null,decimals)}</td><td>${numberText(count?values.reduce((a,v)=>a+v,0)/count:null,decimals)}</td><td>${numberText(count?values.reduce((a,v)=>Math.max(a,v),-Infinity):null,decimals)}</td><td>${count}</td></tr>`;}).join('');
  const label=(t)=>dateText(t,{year:'numeric',month:'2-digit',day:'2-digit'});
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HMP7 温湿度测量记录</title><style>
*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#23354e;font:16px/1.7 "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:1034px;margin:30px auto;background:white;padding:42px}
.report-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px 20px;margin-bottom:16px}.report-heading{min-width:0}.report-brand{width:200px;max-width:100%;line-height:0;margin-bottom:16px}.report-brand{display:flex;align-items:center;gap:9px;line-height:1.3;color:#183c47}.report-brand img{display:block;width:32px;height:32px}.report-brand strong{font-size:18px}.report-header h1{font-size:28px;margin:0;white-space:nowrap}.report-print{flex:0 0 auto;white-space:nowrap;border:0;background:#3767c9;color:white;border-radius:6px;padding:11px 19px;font-size:15px;cursor:pointer}
h2{font-size:19px;margin:0 0 12px}.meta{color:#5c708c;font-size:15px;overflow-wrap:anywhere}.table-wrap{max-width:100%;overflow-x:auto}table{border-collapse:collapse;width:100%;margin:25px 0;font-size:15px}th,td{border-bottom:1px solid #e1e7f0;padding:11px 12px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#f3f6fa;color:#5c708c}.chart{margin:27px 0;break-inside:avoid;page-break-inside:avoid}svg{width:100%;height:auto}.note{font-size:14px;color:#63748b;border-top:1px solid #e3e8ef;margin-top:25px;padding-top:16px}
@page{size:A4;margin:15mm}@media print{body{background:white}main{margin:0;padding:0;max-width:none}.report-print{display:none!important}.report-header{display:block;margin-bottom:12px}.report-brand{width:58mm;margin-bottom:12px}.report-header h1{font-size:24px}.meta{font-size:12px}.table-wrap{overflow:visible}table{font-size:12px}th,td{padding:8px}h2{font-size:16px}.chart{margin:22px 0}svg{max-height:200px}.note{font-size:12px}}
@media screen and (max-width:650px){main{padding:20px;margin:0}.report-header h1{font-size:24px}.report-print{font-size:14px;padding:10px 14px}table{font-size:12px}th,td{padding:8px 4px}}@media screen and (max-width:360px){main{padding:16px}.report-header h1{font-size:22px}}
</style></head><body><main><header class="report-header"><div class="report-heading"><div class="report-brand"><img alt="" src="${reportLogo}"><strong>Better HMP7</strong></div><h1>温湿度测量记录</h1></div><button class="report-print" onclick="window.print()">打印 / 另存为 PDF</button></header>
<div class="meta">设备：${escaped(info.vendor||'Vaisala')} ${escaped(info.model||'HMP7')}　固件：${escaped(info.firmware||'—')}<br>实际采样时段：${escaped(label(start))} — ${escaped(label(end))}（北京时间）<br>采样间隔：${intervalSeconds} 秒　有效写入 CSV：${points.length} 条　采样跨度：${durationText(end-start)}<br>原始数据文件：${escaped(csvName)}</div><div class="table-wrap"><table><thead><tr><th>测量项</th><th>单位</th><th>最小值</th><th>平均值</th><th>最大值</th><th>有效读数</th></tr></thead><tbody>${rows}</tbody></table></div>${reportMetrics.map((key)=>`<section class="chart"><h2>${escaped(CHANNELS[key].name)}</h2>${reportChart(points,key)}</section>`).join('')}<p class="note">统计使用本次已写入 CSV 的全部有效读数；曲线显示勾选测量项的完整记录时段，与实时视图缩放无关。长记录保留各时间段的最高、最低及首末真实采样点；缺测处断开。CSV 保留所有原始采样。本报告是测量记录，不是校准证书。</p></main></body></html>`;
}
async function exportReport(event) {
  if (!recordedPoints.length || fileBusy || pickerBusy) return;
  try {
    const handle=await nativePicker('report', {suggestedName:`HMP7-测量报告-${fileStamp()}.html`,startIn:'desktop',types:[{description:'可打印测量报告',accept:{'text/html':['.html']}}]}, event);

    fileBusy=true;renderStatus();await writeChain;
    const points=recordedPoints.slice();await writeComplete(handle,makeReport(points));
    toast('报告已保存为 HTML。打开报告，点击“打印 / 另存为 PDF”即可。');
  }catch(error){pickerError(error,'保存报告');}
  finally{fileBusy=false;renderStatus();}
}
async function exportCSV(event) {
  if(!recordedPoints.length||fileBusy||pickerBusy)return;
  try{
    const handle=await nativePicker('csv', {suggestedName:csvName.replace(/\.csv$/i,'')+'-原始数据.xlsx',startIn:'desktop',types:[{description:'Excel 原始测量数据',accept:{'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':['.xlsx']}}]}, event);

    fileBusy=true;renderStatus();await writeChain;
    const workbook = HMP7Xlsx.create({points:recordedPoints.slice(),metrics:HMP7Metrics.measurements,intervalSeconds:recordingIntervalMs/1000});
    await writeComplete(handle,workbook);toast('Excel 已保存，时间与数据列已设置宽度，实时 CSV 保持不变。');
  }catch(error){pickerError(error,'保存 Excel');}
  finally{fileBusy=false;renderStatus();}
}
initializeMetrics();
$('sampling-interval').value = String(samplingIntervalMs);
$('sampling-interval').addEventListener('change', () => {
  if(recording || fileBusy) { $('sampling-interval').value = String(samplingIntervalMs); return; }
  const value = Number($('sampling-interval').value);
  if(value >= 500 && value <= 5000 && value % 500 === 0) {
    samplingIntervalMs = value;
    saveSettings();
  }
});
document.querySelectorAll('[data-duration]').forEach((button)=>button.addEventListener('click',()=>{
  duration=Number(button.dataset.duration);customBounds=null;
  document.querySelectorAll('[data-duration]').forEach((el)=>{const selected=el===button;el.classList.toggle('selected',selected);el.setAttribute('aria-pressed',String(selected));});
  $('custom-range').classList.remove('selected');$('custom-range').setAttribute('aria-pressed','false');$('date-range').hidden=!document.body.classList.contains('history-view');rebuildHistory();renderRecording();syncCurveControls();
}));
$('custom-range').addEventListener('click',()=>{$('date-range').hidden=!$('date-range').hidden;});
$('date-range').addEventListener('submit',(event)=>{event.preventDefault();const start=new Date($('range-start').value).getTime()/1000,end=new Date($('range-end').value).getTime()/1000;if(!finite(start+end)||start>=end){toast('请选择有效的时间范围');return;}customBounds={start,end};document.querySelectorAll('[data-duration]').forEach((el)=>{el.classList.remove('selected');el.setAttribute('aria-pressed','false');});$('custom-range').classList.add('selected');$('custom-range').setAttribute('aria-pressed','true');rebuildHistory();renderRecording();});
$('connect-button').addEventListener('click',connectProbe);$('dialog-connect-button').addEventListener('click',connectProbe);
$('folder-button').addEventListener('click',chooseRecordingFile);
$('recording-button').addEventListener('click',(event)=>recording?stopRecording():startRecording(event));
$('export-button').addEventListener('click',exportReport);$('export-csv-button').addEventListener('click',exportCSV);
$('nav-live').addEventListener('click',()=>switchView(false));$('nav-history').addEventListener('click',()=>switchView(true));
document.querySelectorAll('[data-open-setup]').forEach((button)=>button.addEventListener('click',()=>$('setup-dialog').showModal()));
$('close-setup').addEventListener('click',()=>$('setup-dialog').close());
$('setup-dialog').addEventListener('click',(event)=>{if(event.target===$('setup-dialog')){const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();}});
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); switchView(false); });
$('reset-view').addEventListener('click', resetViewport);
const plot = $('main-chart');
plot.addEventListener('wheel', event => {
  if (!chartGeometry?.points.length || event.ctrlKey || event.metaKey) return;
  const box=plot.getBoundingClientRect(), pixel=event.clientX-box.left;
  if(pixel<chartGeometry.left||pixel>chartGeometry.left+chartGeometry.plotW)return;
  event.preventDefault();
  const bounds=customBounds||{start:chartGeometry.start,end:chartGeometry.end};
  const anchor=bounds.start+(pixel-chartGeometry.left)/chartGeometry.plotW*(bounds.end-bounds.start);
  const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?box.height:1);
  freezeViewport(HMP7ChartView.zoom(bounds,anchor,Math.exp(Math.max(-1,Math.min(1,delta*.002))),availableBounds()));
},{passive:false});
plot.addEventListener('pointerdown', event => {
  if(event.button!==0||!chartGeometry?.points.length)return;
  const box=plot.getBoundingClientRect(), pixel=event.clientX-box.left;
  if(pixel<chartGeometry.left||pixel>chartGeometry.left+chartGeometry.plotW)return;
  event.preventDefault();
  dragState={id:event.pointerId,x:event.clientX,bounds:{start:chartGeometry.start,end:chartGeometry.end},width:chartGeometry.plotW};
  plot.setPointerCapture(event.pointerId);plot.classList.add('is-dragging');$('chart-tooltip').hidden=true;
});
function endDrag(event) {
  if(!dragState||event.pointerId!==dragState.id)return;
  if(plot.hasPointerCapture(event.pointerId))plot.releasePointerCapture(event.pointerId);
  dragState=null;plot.classList.remove('is-dragging');
}
plot.addEventListener('pointerup',endDrag);plot.addEventListener('pointercancel',endDrag);
plot.addEventListener('lostpointercapture',()=>{dragState=null;plot.classList.remove('is-dragging');});
plot.addEventListener('dblclick',resetViewport);
plot.addEventListener('pointermove',event=>{
  if(dragState){freezeViewport(HMP7ChartView.pan(dragState.bounds,-(event.clientX-dragState.x)/dragState.width,availableBounds()));return;}
  if(!chartGeometry?.points.length)return;
  const box=plot.getBoundingClientRect(),lx=event.clientX-box.left;
  if(lx<chartGeometry.left||lx>chartGeometry.left+chartGeometry.plotW){$('chart-tooltip').hidden=true;return;}
  const t=chartGeometry.start+(lx-chartGeometry.left)/chartGeometry.plotW*(chartGeometry.end-chartGeometry.start),points=chartGeometry.points;
  let lo=0,hi=points.length-1;while(lo<hi){const mid=(lo+hi)>>1;if(points[mid].ts<t)lo=mid+1;else hi=mid;}
  let best=points[lo];if(lo&&Math.abs(points[lo-1].ts-t)<Math.abs(best.ts-t))best=points[lo-1];
  const tip=$('chart-tooltip');tip.replaceChildren();const stamp=document.createElement('span');stamp.textContent=dateText(best.ts);tip.append(stamp);
  for(const key of selectedChannels){const row=document.createElement('div');row.className='tooltip-value';row.style.setProperty('--channel',CHANNELS[key].color);row.textContent=`${CHANNELS[key].name}：${numberText(best[key],CHANNELS[key].decimals??2)} ${CHANNELS[key].unit}`;tip.append(row);}
  tip.hidden=false;const cb=$('chart-area').getBoundingClientRect();tip.style.left=`${Math.max(6,Math.min(event.clientX-cb.left+12,cb.width-tip.offsetWidth-6))}px`;tip.style.top=`${Math.max(5,Math.min(event.clientY-cb.top+12,cb.height-tip.offsetHeight-5))}px`;
  $('hover-line')?.setAttribute('x1',chartGeometry.x(best.ts));$('hover-line')?.setAttribute('x2',chartGeometry.x(best.ts));$('hover-line')?.setAttribute('visibility','visible');
});
plot.addEventListener('pointerleave',()=>{if(!dragState){$('chart-tooltip').hidden=true;$('hover-line')?.setAttribute('visibility','hidden');}});
new ResizeObserver(()=>renderChart()).observe($('chart-area'));
if(window.HMP7Serial)HMP7Serial.onDisconnect(({reason,message})=>{clearTimeout(sampleTimer);if(recording)stopRecording(true);if(reason!=='manual'){latestError=message||'探头已断开';addEvent(latestError);}else addEvent('已断开本机探头');renderStatus();});
window.addEventListener('pagehide',()=>{pageClosing=true;recording=false;recordingGeneration++;recordingStopped=serverTime();clearTimeout(sampleTimer);HMP7Serial?.disconnect().catch(()=>{});});
window.addEventListener('pageshow',(event)=>{if(event.persisted){pageClosing=false;recording=false;recordingGeneration++;clearTimeout(sampleTimer);renderStatus();toast('页面已恢复。请重新连接探头并手动开始记录。');}});
text('today',new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric'}).format(new Date()));
$('range-start').value=localDateInput(serverTime()-3600);$('range-end').value=localDateInput(serverTime());
HMP7Desktop.ready.then(api => api.preferences()).then(prefs => {
  selectedChannels.clear();
  for (const key of prefs.curves) if (CHANNELS[key]) selectedChannels.add(key);
  samplingIntervalMs = prefs.interval * 1000;
  $('sampling-interval').value = String(samplingIntervalMs);
  syncCurveControls(); rebuildHistory();
}).catch(error => { latestError = '偏好读取失败：' + error.message; }).finally(() => {
  preferencesLoaded = true; document.body.dataset.desktopReady = 'true'; renderStatus();
});
setInterval(()=>{if(!pageClosing){renderStatus();}},1000);
renderStatus();rebuildHistory();
