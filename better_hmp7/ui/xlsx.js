/* Local-only XLSX export. ZIP store + SpreadsheetML; no network, macros or formula cells. */
(function (root) {
  'use strict';
  const encoder = new TextEncoder();
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const DATE_FORMAT = 'yyyy-mm-dd hh:mm:ss.000';
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }

  function xml(value) {
    return String(value ?? '').replace(/_x([0-9a-f]{4})_/gi, '_x005F_x$1_')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  }
  function colName(index) {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name;
    return name;
  }
  function textCell(ref, value, style = 0) {
    return `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
  }
  function numberCell(ref, value, style = 0) {
    return Number.isFinite(value) ? `<c r="${ref}" t="n" s="${style}"><v>${value}</v></c>` : '';
  }
  function normalizedMetrics(metrics) {
    if (!Array.isArray(metrics) || metrics.length > 16382) throw new Error('测量项数量超过 Excel 的列数限制');
    return metrics.map((metric) => {
      if (!metric || typeof metric.key !== 'string' || !metric.key) throw new Error('测量项缺少字段名称');
      const decimals = Number.isInteger(metric.decimals) ? Math.min(8, Math.max(0, metric.decimals)) : 2;
      const name = String(metric.name || metric.label || metric.key), unit = String(metric.unit || '');
      const title = unit ? `${name}（${unit}）` : name;
      const textWidth = Array.from(title).reduce((width, character) => width + (character.codePointAt(0) > 255 ? 2 : 1), 0);
      return { key: metric.key, title, decimals, width: Math.max(18, Math.min(24, textWidth + 3)) };
    });
  }
  function styles() {
    const formats = Array.from({ length: 9 }, (_, decimals) => `<numFmt numFmtId="${165 + decimals}" formatCode="${decimals ? '0.' + '0'.repeat(decimals) : '0'}"/>`).join('');
    const numericStyles = Array.from({ length: 9 }, (_, decimals) => `<xf numFmtId="${165 + decimals}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`).join('');
    return XML + `<styleSheet xmlns="${NS}"><numFmts count="10"><numFmt numFmtId="164" formatCode="${DATE_FORMAT}"/>${formats}</numFmts>` +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FF203653"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FA"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="12"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
      numericStyles + '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  }
  function excelTime(timestamp, offsetHours = 0) {
    if (!Number.isFinite(timestamp)) return null;
    const serial = (Math.round(timestamp * 1000) + offsetHours * 3600000) / 86400000 + 25569;
    // This instrument records modern dates; unsupported Excel dates are left blank.
    return Number.isFinite(serial) && serial >= 61 && serial < 2958466 ? serial : null;
  }
  function dataSheet(points, metrics) {
    const lastColumn = colName(metrics.length + 1), lastRow = points.length + 1;
    const parts = [], push = (value) => parts.push(encoder.encode(value));
    const columns = '<col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/>' +
      metrics.map((metric, index) => `<col min="${index + 3}" max="${index + 3}" width="${metric.width}" customWidth="1"/>`).join('');
    push(XML + `<worksheet xmlns="${NS}"><dimension ref="A1:${lastColumn}${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="16"/><cols>${columns}</cols><sheetData>`);
    push('<row r="1" ht="30" customHeight="1">' + ['时间（UTC）', '时间（北京时间）', ...metrics.map((metric) => metric.title)].map((title, index) => textCell(`${colName(index)}1`, title, 2)).join('') + '</row>');
    let batch = [];
    for (let index = 0; index < points.length; index++) {
      const point = points[index] || {}, row = index + 2;
      const timestamp = Number.isFinite(point.ts) ? point.ts : point.timestamp;
      const cells = [numberCell(`A${row}`, excelTime(timestamp), 1), numberCell(`B${row}`, excelTime(timestamp, 8), 1)];
      for (let column = 0; column < metrics.length; column++) {
        const metric = metrics[column];
        cells.push(numberCell(`${colName(column + 2)}${row}`, point[metric.key], 3 + metric.decimals));
      }
      batch.push(`<row r="${row}">${cells.join('')}</row>`);
      if (batch.length >= 256) { push(batch.join('')); batch = []; }
    }
    if (batch.length) push(batch.join(''));
    push(`</sheetData><autoFilter ref="A1:${lastColumn}${lastRow}"/><pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`);
    return parts;
  }
  function notesSheet(intervalSeconds, pointCount) {
    const rows = [
      ['项目', '说明'],
      ['采样间隔（秒）', Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : '未提供'],
      ['记录条数', pointCount],
      ['时间列', 'UTC 与北京时间分别保存为 Excel 日期时间值；北京时间固定为 UTC+08:00。'],
      ['时间显示', DATE_FORMAT],
      ['测量数据', '保留原始数值；显示小数位按测量项配置。空白表示未获得有效值，不代表零。'],
      ['数据范围', '本次导出的已记录采样点；不受实时曲线缩放或测量项勾选影响。'],
      ['文件说明', '此文件仅为测量原始数据，不是校准证书。'],
    ];
    return XML + `<worksheet xmlns="${NS}"><dimension ref="A1:B${rows.length}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="110" customWidth="1"/></cols><sheetData>` +
      rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => typeof value === 'number' ? numberCell(`${colName(column)}${index + 1}`, value) : textCell(`${colName(column)}${index + 1}`, value, index === 0 ? 2 : 0)).join('')}</row>`).join('') + '</sheetData></worksheet>';
  }
  function zip(files) {
    let offset = 0;
    const entries = files.map(([name, content]) => {
      const filename = encoder.encode(name), chunks = Array.isArray(content) ? content : [encoder.encode(content)];
      let size = 0, crc = 0xffffffff;
      for (const chunk of chunks) {
        size += chunk.length;
        for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      }
      const entry = { filename, chunks, size, crc: (crc ^ 0xffffffff) >>> 0, offset };
      offset += 30 + filename.length + size;
      if (offset > 0xffffffff || size > 0xffffffff) throw new Error('数据过大，超出本地 XLSX 导出的文件大小限制');
      return entry;
    });
    const centralOffset = offset, centralSize = entries.reduce((size, entry) => size + 46 + entry.filename.length, 0);
    if (centralOffset + centralSize + 22 > 0xffffffff) throw new Error('数据过大，请缩短记录时段后导出');
    const bytes = new Uint8Array(centralOffset + centralSize + 22), view = new DataView(bytes.buffer);
    const u16 = (position, value) => view.setUint16(position, value, true), u32 = (position, value) => view.setUint32(position, value, true);
    for (const entry of entries) {
      let at = entry.offset;
      u32(at, 0x04034b50); u16(at + 4, 20); u16(at + 6, 0x0800); u16(at + 8, 0); u16(at + 12, 0x21);
      u32(at + 14, entry.crc); u32(at + 18, entry.size); u32(at + 22, entry.size); u16(at + 26, entry.filename.length);
      bytes.set(entry.filename, at + 30); at += 30 + entry.filename.length;
      for (const chunk of entry.chunks) { bytes.set(chunk, at); at += chunk.length; }
    }
    offset = centralOffset;
    for (const entry of entries) {
      u32(offset, 0x02014b50); u16(offset + 4, 20); u16(offset + 6, 20); u16(offset + 8, 0x0800); u16(offset + 10, 0); u16(offset + 14, 0x21);
      u32(offset + 16, entry.crc); u32(offset + 20, entry.size); u32(offset + 24, entry.size); u16(offset + 28, entry.filename.length); u32(offset + 42, entry.offset);
      bytes.set(entry.filename, offset + 46); offset += 46 + entry.filename.length;
    }
    u32(offset, 0x06054b50); u16(offset + 8, entries.length); u16(offset + 10, entries.length); u32(offset + 12, centralSize); u32(offset + 16, centralOffset);
    return bytes;
  }
  function create({ points, metrics, intervalSeconds } = {}) {
    if (!Array.isArray(points)) throw new Error('缺少测量记录');
    if (points.length > 1048575) throw new Error('记录超过 Excel 单表 1048575 条数据的上限');
    const selected = normalizedMetrics(metrics);
    const contentTypes = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
    const relationships = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    const workbook = XML + `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="原始数据" sheetId="1" r:id="rId1"/><sheet name="说明" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    const workbookRels = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    return zip([
      ['[Content_Types].xml', contentTypes], ['_rels/.rels', relationships], ['xl/workbook.xml', workbook],
      ['xl/_rels/workbook.xml.rels', workbookRels], ['xl/styles.xml', styles()],
      ['xl/worksheets/sheet1.xml', dataSheet(points, selected)], ['xl/worksheets/sheet2.xml', notesSheet(intervalSeconds, points.length)],
    ]);
  }
  root.HMP7Xlsx = Object.freeze({ create });
})(typeof window !== 'undefined' ? window : globalThis);
