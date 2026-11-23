/* HMP7 only. Vaisala M212022EN-M, zero-based Modbus PDU addresses.
 * Metadata describes read-only display: no configuration writes are implemented.
 * Model-specific output table excludes the MMP8-only oil/water-activity outputs. */
(function (root) {
  'use strict';
  const base = 'https://docs.vaisala.com/r/M212022EN-M/en-US/';
  const sources = Object.freeze({
    specifications: base + 'GUID-39149B80-C4B3-4179-A200-6F86CD12FCEC',
    measurements: base + 'GUID-E824E3DB-16EE-4BB4-80A0-57E39B595A65/GUID-34BF03C8-7BF9-4A85-9DBE-14D60DD3FFE8',
    configuration: base + 'GUID-E824E3DB-16EE-4BB4-80A0-57E39B595A65/GUID-60AE309B-428F-48CA-9796-C051F3CB2E39',
    status: base + 'GUID-E824E3DB-16EE-4BB4-80A0-57E39B595A65/GUID-C1817F72-29AB-4CAB-8C6D-00ACD095C536',
    warming: base + 'GUID-733DB5B6-2600-427D-8F8E-02248A967F70',
    pressure: base + 'GUID-65A9D4D0-3187-4B8C-92D4-44549DC90F23/GUID-ABD44E94-8802-444D-B90C-AE3471E918AB'
  });
  const temperatureNote = '防冷凝加热启用时，依赖环境温度的量可能需要外部温度补偿；以探头实际输出与状态为准。';
  const pressureNote = '此计算量受压力补偿设置影响；压力来自设置值，不是压力传感器测量。';
  function metric(key, name, unit, register, decimals, minimumSpan, color, description) {
    return Object.freeze({ key, name, label: name, unit, register, count: 2, dataType: 'float32',
      type: 'number', decimals, minimumSpan, color, group: 'measurement', description,
      source: sources.measurements });
  }
  const measurements = Object.freeze([
    metric('temperature', '温度', '°C', 0x0002, 2, 0.5, '#2563eb', '探头输出的温度。' + temperatureNote),
    metric('humidity', '相对湿度', '%RH', 0x0000, 2, 1, '#0d9488', '相对于水面饱和蒸气压的相对湿度。' + temperatureNote),
    metric('dewpoint', '露点温度', '°C', 0x0006, 2, 0.5, '#7c3aed', '相对于液态水的露点温度；探头可直接输出。'),
    metric('absolute_humidity', '绝对湿度', 'g/m³', 0x000e, 3, 0.2, '#ea580c', '单位体积气体中的水蒸气质量。' + temperatureNote),
    metric('dew_frost_point', '露点 / 霜点', '°C', 0x0008, 2, 0.5, '#0891b2', '根据温度使用露点或霜点表示水汽含量。'),
    metric('dew_frost_point_atm', '标准大气压露点 / 霜点', '°C', 0x000a, 2, 0.5, '#4f46e5', '换算到 1 atm 的露点或霜点。' + pressureNote),
    metric('dewpoint_atm', '标准大气压露点', '°C', 0x000c, 2, 0.5, '#a855f7', '换算到 1 atm 的露点温度。' + pressureNote),
    metric('mixing_ratio', '混合比', 'g/kg', 0x0010, 3, 0.2, '#16a34a', '水蒸气质量与干气体质量之比。' + pressureNote),
    metric('wet_bulb', '湿球温度', '°C', 0x0012, 2, 0.5, '#0284c7', '由探头计算的湿球温度，不是独立湿球传感器。' + pressureNote),
    metric('water_concentration', '水汽体积分数', 'ppmv', 0x0014, 1, 100, '#d97706', '水蒸气体积浓度，以百万分比表示。' + pressureNote),
    metric('vapor_pressure', '水蒸气分压', 'hPa', 0x0016, 3, 0.2, '#db2777', '水蒸气的分压力，由湿度及温度计算。'),
    metric('saturation_pressure', '饱和水蒸气压', 'hPa', 0x0018, 3, 0.2, '#e11d48', '当前温度下的饱和水蒸气压力。' + temperatureNote),
    metric('enthalpy', '比焓', 'kJ/kg', 0x001a, 2, 1, '#9333ea', '湿空气的比焓计算量。' + pressureNote),
    metric('dew_frost_depression', '露点 / 霜点差', '°C', 0x001e, 2, 0.5, '#059669', '温度与露点或霜点的差值。' + temperatureNote),
    metric('absolute_humidity_ntp', '标准状态绝对湿度', 'g/m³', 0x0020, 3, 0.2, '#65a30d', '换算至探头定义的 NTP 标准状态的绝对湿度。' + pressureNote),
    metric('water_concentration_wet', '水汽体积分数（湿基）', 'vol-%', 0x002a, 4, 0.02, '#c026d3', '以含水气体总体积为基准的水汽百分比。' + pressureNote),
    metric('humidity_dew_frost', '相对湿度（露点 / 霜点）', '%RH', 0x002c, 2, 1, '#0f766e', '根据露点或霜点定义的相对湿度。' + temperatureNote),
    metric('water_mass_fraction', '水汽质量分数', 'ppmw', 0x0040, 1, 100, '#b45309', '水蒸气质量分数，以百万分比表示；较旧固件可能不提供。' + pressureNote)
  ]);
  const onOff = Object.freeze({ 0: '关闭', 1: '开启' });
  const measurementBits = Object.freeze({ 1: '不可用', 2: '不可靠', 4: '低于量程', 8: '高于量程', 32: '读数锁定', 128: '传感器故障', 256: '尚未就绪' });
  function parameter(key, name, unit, register, dataType, group, description, extras = {}) {
    return Object.freeze({ key, name, label: name, unit, register, dataType, group,
      count: ['float32', 'int32'].includes(dataType) ? 2 : 1,
      type: dataType === 'float32' ? 'number' : 'integer', decimals: dataType === 'float32' ? 2 : 0,
      minimumSpan: 1, color: group === 'status' ? '#0d9488' : '#64748b', description,
      source: group === 'status' ? sources.status : sources.configuration, ...extras });
  }
  const parameters = Object.freeze([
    parameter('pressure_compensation', '压力补偿设置', 'hPa', 0x0300, 'float32', 'config', '用于计算的环境压力设置值，不是实时压力测量；默认 1013.25 hPa，重启后保留。'),
    parameter('temperature_compensation', '外部温度补偿', '°C', 0x0334, 'float32', 'config', '外部输入的温度补偿值；设置后替代探头自身温度参与计算，重启后清除。本网页不写入此设置。'),
    parameter('purge_interval', '传感器清除周期', 'min', 0x0304, 'float32', 'config', '化学物质清除的间隔设置；适用于支持传感器清除功能的配置。'),
    parameter('filtering_factor', '测量滤波系数', '', 0x031a, 'float32', 'config', '新读数在滤波结果中的权重；1 为不进行平滑，是否启用另见测量滤波开关。', { decimals: 3 }),
    parameter('condensation_prevention', '防冷凝加热', '', 0x0506, 'uint16', 'config', '此值表示功能开关，不代表正在加热。USB 转接供电低于 18 V 时，加热不会运行。', { type: 'boolean', values: onOff }),
    parameter('interval_purge', '周期清除', '', 0x0502, 'uint16', 'config', '周期性传感器清除开关；仅显示，不执行清除。', { type: 'boolean', values: onOff }),
    parameter('startup_purge', '启动时清除', '', 0x0503, 'uint16', 'config', '设备启动时的传感器清除开关；仅显示。', { type: 'boolean', values: onOff }),
    parameter('filtering_enabled', '测量滤波', '', 0x0501, 'uint16', 'config', '是否使用设置的测量滤波系数。', { type: 'boolean', values: onOff }),
    parameter('modbus_address', '设备通信地址', '', 0x0600, 'uint16', 'config', '探头当前 Modbus 地址；本网页连接地址固定为已验证的 240。'),
    parameter('bit_rate', '通信速率', 'bit/s', 0x0601, 'uint16', 'config', '设备保存的串口速率设置；网页当前以 19200 bit/s 连接。', { type: 'enum', values: Object.freeze({ 0: '300', 1: '600', 2: '1200', 3: '2400', 4: '4800', 5: '9600', 6: '19200', 7: '38400', 8: '57600', 9: '115200' }) }),
    parameter('serial_format', '串口格式', '', 0x0602, 'uint16', 'config', '校验方式、数据位与停止位。', { type: 'enum', values: Object.freeze({ 0: '无校验 · 8 位 · 1 停止位', 1: '无校验 · 8 位 · 2 停止位', 2: '偶校验 · 8 位 · 1 停止位', 3: '偶校验 · 8 位 · 2 停止位', 4: '奇校验 · 8 位 · 1 停止位', 5: '奇校验 · 8 位 · 2 停止位' }) }),
    parameter('response_delay', '通信响应延迟', 'ms', 0x0603, 'uint16', 'config', '设备设置的响应延迟，不是本次采样耗时。'),
    parameter('error_status', '故障状态', '', 0x0200, 'uint16', 'status', '设备汇总错误标志；协议定义 0 表示有错误、1 表示无错误。', { type: 'enum', values: Object.freeze({ 0: '存在错误', 1: '无错误' }) }),
    parameter('online_status', '数据输出状态', '', 0x0201, 'uint16', 'status', '输出锁定时不将锁定的读数记作有效实时数据。', { type: 'enum', values: Object.freeze({ 0: '输出锁定', 1: '数据可用' }) }),
    parameter('error_code', '详细故障', '', 0x0203, 'int32', 'status', '多个故障标志可以同时出现。', { type: 'bitmask', values: Object.freeze({ 0: '正常' }), bits: Object.freeze({ 1: '温度测量错误', 2: '湿度测量错误', 4: '湿度传感器故障', 8: '电容参考错误', 16: '环境温度超范围', 8388608: '传感器加热故障' }) }),
    parameter('settings_hash', '设置校验标识', '', 0x0205, 'int32', 'status', '设置或校准发生变化时会改变的标识；不是密码，也不是测量值。', { type: 'hex' }),
    parameter('humidity_status', '湿度测量状态', '', 0x0207, 'int16', 'status', '湿度输出的可用性及量程状态。', { type: 'bitmask', values: Object.freeze({ 0: '正常' }), bits: measurementBits }),
    parameter('temperature_status', '温度测量状态', '', 0x0208, 'int16', 'status', '温度输出的可用性及量程状态。', { type: 'bitmask', values: Object.freeze({ 0: '正常' }), bits: measurementBits }),
    parameter('dew_frost_status', '露点 / 霜点状态', '', 0x0209, 'int16', 'status', '露点或霜点输出的可用性及量程状态。', { type: 'bitmask', values: Object.freeze({ 0: '正常' }), bits: measurementBits }),
    parameter('device_status', '设备运行状态', '', 0x020a, 'int16', 'status', '运行状态标志；多个状态可以同时出现。', { type: 'bitmask', values: Object.freeze({ 0: '正常' }), bits: Object.freeze({ 1: '严重错误，需维护', 2: '可恢复错误', 4: '警告', 8: '通知', 16: '校准模式' }) })
  ]);
  const all = Object.freeze([...measurements, ...parameters]);
  const byKey = Object.freeze(Object.fromEntries(all.map(item => [item.key, item])));
  function formatValue(key, value) {
    const item = byKey[key];
    if (value == null || !Number.isFinite(value)) return '—';
    if (!item) return String(value);
    if (item.values && Object.hasOwn(item.values, value)) return item.values[value];
    if (item.type === 'bitmask') {
      const parts = []; let known = 0;
      for (const [flag, label] of Object.entries(item.bits)) {
        known |= Number(flag); if ((value & Number(flag)) !== 0) parts.push(label);
      }
      const unknown = ((value >>> 0) & ~known) >>> 0;
      if (unknown) parts.push('未知标志 0x' + unknown.toString(16).toUpperCase());
      return parts.join('；') || String(value);
    }
    if (item.type === 'hex') return '0x' + (value >>> 0).toString(16).padStart(8, '0').toUpperCase();
    if (item.type === 'enum' || item.type === 'boolean') return '未知值 ' + value;
    return value.toFixed(item.decimals);
  }
  root.HMP7Metrics = Object.freeze({ measurements, parameters, all, byKey, sources, formatValue });
})(globalThis);
