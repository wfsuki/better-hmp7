import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const scope = vm.createContext({ TextEncoder, Uint8Array, Uint32Array, DataView, window: {} });
vm.runInContext(fs.readFileSync(new URL('../better_hmp7/ui/xlsx.js', import.meta.url), 'utf8'), scope);
const create = scope.window.HMP7Xlsx.create;
const metricsScope = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(new URL('../better_hmp7/ui/metrics.js', import.meta.url), 'utf8'), metricsScope);
const metrics = (metricsScope.HMP7Metrics || metricsScope.window.HMP7Metrics).measurements;
const timestamp = Date.parse('2026-11-11T15:59:59.123Z') / 1000;
const first = Object.fromEntries(metrics.map((metric, index) => [metric.key, index + .123456]));
const points = [
  { ...first, ts: timestamp, temperature: 0, humidity: null, dewpoint: -12.3456 },
  { ...first, ts: timestamp + 2, temperature: 19.987654321, humidity: 50.123, dewpoint: NaN, absolute_humidity: Infinity },
  { ts: timestamp + 2.5, temperature: '=HYPERLINK("https://example.invalid")', humidity: '42', dewpoint: false },
];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function unpack(bytes) {
  const buffer = Buffer.from(bytes), files = new Map();
  let at = 0;
  while (buffer.readUInt32LE(at) === 0x04034b50) {
    assert.equal(buffer.readUInt16LE(at + 8), 0, 'ZIP store avoids hidden runtime compression dependencies');
    const crc = buffer.readUInt32LE(at + 14), size = buffer.readUInt32LE(at + 18);
    const nameSize = buffer.readUInt16LE(at + 26), extraSize = buffer.readUInt16LE(at + 28);
    const name = buffer.subarray(at + 30, at + 30 + nameSize).toString('utf8');
    const start = at + 30 + nameSize + extraSize, data = buffer.subarray(start, start + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.set(name, data.toString('utf8')); at = start + size;
  }
  assert.equal(buffer.readUInt32LE(at), 0x02014b50);
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 10), files.size);
  assert.equal(buffer.readUInt32LE(end + 16), at);
  let centralCount = 0;
  while (buffer.readUInt32LE(at) === 0x02014b50) {
    const length = buffer.readUInt16LE(at + 28), localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + length).toString('utf8');
    assert(files.has(name));
    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50);
    assert.equal(buffer.readUInt32LE(at + 16), buffer.readUInt32LE(localOffset + 14));
    at += 46 + length; centralCount++;
  }
  assert.equal(centralCount, files.size);
  assert.equal(at, end);
  return files;
}

test('ZIP package has valid CRC and directory offsets with complete local SpreadsheetML parts', () => {
  const bytes = create({ points, metrics, intervalSeconds: .5 });
  assert(bytes instanceof Uint8Array);
  const files = unpack(bytes);
  assert.equal(files.size, 7);
  assert(files.has('[Content_Types].xml'));
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert(sheet.includes('ref="A1:T4"'));
  assert(sheet.includes('state="frozen"'));
  assert(sheet.includes('<autoFilter ref="A1:T4"/>'));
  assert(sheet.includes('时间（北京时间）'));
  assert(sheet.includes('相对湿度（%RH）'));
  assert(sheet.includes('<c r="C2" t="n" s="5"><v>0</v></c>'));
  assert(!sheet.includes('r="D2"'));
  assert(!sheet.includes('NaN') && !sheet.includes('Infinity') && !sheet.includes('HYPERLINK'));
  assert(files.get('xl/styles.xml').includes('yyyy-mm-dd hh:mm:ss.000'));
});

test('Excel-readable fixture retains dates, time zone offset, widths, units, values, blanks and metadata', () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmp7-xlsx-test-'));
  const fixture = path.join(fixtureDir, 'hmp7-fixture.xlsx');
  try {
    fs.writeFileSync(fixture, create({ points, metrics, intervalSeconds: .5 }));
    const check = spawnSync('python', ['-X', 'utf8', '-c', `
import sys, datetime, zipfile, xml.etree.ElementTree as ET
import openpyxl
book = openpyxl.load_workbook(sys.argv[1], data_only=False)
assert book.sheetnames == ['原始数据', '说明']
sheet = book['原始数据']
assert sheet.max_column == 20 and sheet.max_row == 4
assert sheet['A1'].value == '时间（UTC）'
assert sheet['B1'].value == '时间（北京时间）'
assert sheet['C1'].value == '温度（°C）'
assert sheet['D1'].value == '相对湿度（%RH）'
assert isinstance(sheet['A2'].value, datetime.datetime)
assert sheet['A2'].value == datetime.datetime(2026,11,11,15,59,59,123000)
assert sheet['B2'].value == datetime.datetime(2026,11,11,23,59,59,123000)
assert sheet['B3'].value == datetime.datetime(2026,11,12,0,0,1,123000)
assert sheet['A4'].value == datetime.datetime(2026,11,11,16,0,1,623000)
assert sheet['A2'].number_format == 'yyyy-mm-dd hh:mm:ss.000'
assert sheet['B3'].number_format == 'yyyy-mm-dd hh:mm:ss.000'
assert sheet.column_dimensions['A'].width == 28
assert sheet.column_dimensions['B'].width == 28
for col in list(sheet.columns)[2:]:
    assert 18 <= sheet.column_dimensions[col[0].column_letter].width <= 24
assert sheet.freeze_panes == 'A2'
assert sheet.auto_filter.ref == 'A1:T4'
assert sheet['C2'].value == 0
assert sheet['C3'].value == 19.987654321
assert sheet['E2'].value == -12.3456
assert sheet['D2'].value is None
assert sheet['E3'].value is None and sheet['F3'].value is None
assert all(cell.value is None for cell in sheet[4][2:])
assert all(cell.data_type != 'f' for row in sheet for cell in row)
assert book['说明']['B2'].value == 0.5
assert book['说明']['B3'].value == 3
with zipfile.ZipFile(sys.argv[1]) as archive:
    assert archive.testzip() is None
    for name in archive.namelist(): ET.fromstring(archive.read(name))
print('openpyxl: dates, UTC+08:00, widths, units, raw precision, empty cells and metadata verified')
`, fixture], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert(check.stdout.includes('verified'));
  } finally { fs.rmSync(fixture, { force: true }); fs.rmdirSync(fixtureDir); }
});

test('headers are literal strings even when beginning with formulas and XML characters', () => {
  const bytes = create({ points: [{ ts: timestamp, v: 1 }], metrics: [{ key: 'v', name: '=1+2<&"\u0000', unit: '@cmd', decimals: 4 }] });
  const sheet = unpack(bytes).get('xl/worksheets/sheet1.xml');
  assert(sheet.includes('=1+2&lt;&amp;&quot;（@cmd）'));
  assert(!sheet.includes('<f>'));
  assert(sheet.includes('<c r="C1" t="inlineStr"'));
  assert(sheet.includes('<c r="C2" t="n" s="7"><v>1</v></c>'));
  assert(!sheet.includes('\u0000'));
});

test('empty export still has headers and filter; missing timestamps stay empty', () => {
  const empty = unpack(create({ points: [], metrics, intervalSeconds: 5 })).get('xl/worksheets/sheet1.xml');
  assert(empty.includes('ref="A1:T1"'));
  const invalid = unpack(create({ points: [{ ts: NaN, temperature: 0 }], metrics })).get('xl/worksheets/sheet1.xml');
  assert(!invalid.includes('r="A2"') && !invalid.includes('r="B2"'));
  assert(invalid.includes('<v>0</v>'));
});

test('column naming works beyond Z and large XML chunks retain all rows', () => {
  const columns = Array.from({ length: 30 }, (_, i) => ({ key: 'v' + i, name: '参数' + i, unit: 'g/m³', decimals: i % 5 }));
  const many = Array.from({ length: 1200 }, (_, i) => ({ ts: timestamp + i * .5, v0: i, v29: -i }));
  const sheet = unpack(create({ points: many, metrics: columns, intervalSeconds: .5 })).get('xl/worksheets/sheet1.xml');
  assert(sheet.includes('ref="A1:AF1201"'));
  assert.equal((sheet.match(/<row /g) || []).length, 1201);
  assert(sheet.includes('<c r="AF1201" t="n" s="7"><v>-1199</v></c>'));
});

test('invalid input and Excel limits fail explicitly without truncating rows', () => {
  assert.throws(() => create({ points: null, metrics }), /缺少测量记录/);
  assert.throws(() => create({ points: [], metrics: [null] }), /字段名称/);
  assert.throws(() => create({ points: new Array(1048576), metrics }), /上限/);
  assert.throws(() => create({ points: [], metrics: new Array(16383) }), /列数限制/);
});
