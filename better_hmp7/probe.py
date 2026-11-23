"""Read-only Modbus RTU for a locally attached HMP7. Addresses are zero-based."""
from dataclasses import dataclass
import math
import struct
import threading
import time

import serial
from serial.tools import list_ports

from .catalog import BY_ADDRESS, CONFIG, MEASUREMENTS, STATUS

ADDRESS = 240
CABLE_ID = (0x1843, 0x0200)


class ProtocolError(Exception):
    """Transport or frame error. Reopen the port before starting another request."""


class DeviceException(ProtocolError):
    def __init__(self, code):
        self.code = code
        super().__init__(f"探头返回 Modbus 异常码 {code}")


class Interrupted(Exception):
    """Local disconnect requested."""


def available_ports():
    return sorted(list_ports.comports(), key=lambda p: ((p.vid, p.pid) != CABLE_ID, p.device))


def crc16(data):
    value = 0xffff
    for byte in data:
        value ^= byte
        for _ in range(8):
            value = (value >> 1) ^ (0xa001 if value & 1 else 0)
    return struct.pack("<H", value)


def validate(frame, function):
    if len(frame) < 5 or crc16(frame[:-2]) != frame[-2:] or frame[0] != ADDRESS:
        raise ProtocolError("响应地址或 CRC 校验有误，已停止读取。")
    if frame[1] == function | 0x80 and len(frame) == 5:
        raise DeviceException(frame[2])
    if frame[1] != function:
        raise ProtocolError("响应功能码与请求不符。")


def blocks(fields):
    groups = []
    for field in sorted(fields, key=lambda f: f.address):
        if groups and groups[-1][-1].address + groups[-1][-1].words == field.address:
            groups[-1].append(field)
        else:
            groups.append([field])
    return groups


def read_request(start, words):
    cursor = start
    if not 1 <= words <= 125:
        raise ValueError("无效的寄存器长度")
    while cursor < start + words:
        field = BY_ADDRESS.get(cursor)
        if field is None or cursor + field.words > start + words:
            raise ValueError("不支持的寄存器范围")
        cursor += field.words
    return struct.pack(">BBHH", ADDRESS, 3, start, words)


def decode(raw, field):
    if field.format in ("float32", "int32"):
        raw = raw[2:] + raw[:2]
        value = struct.unpack(">f" if field.format == "float32" else ">i", raw)[0]
        return value if math.isfinite(value) else None
    value = struct.unpack(">h" if field.format == "int16" else ">H", raw)[0]
    return None if field.format == "int16" and value == -32768 else value


@dataclass(slots=True)
class Sample:
    timestamp: float
    measurements: dict
    parameters: dict
    warning: str = ""


class Probe:
    def __init__(self, stream, cancelled):
        self.stream = stream
        self.cancelled = cancelled
        self.unsupported = set()
        self.split = set()
        self.settings = {}
        self.next_settings = 0.0

    @classmethod
    def open(cls, device, cancelled):
        stream = serial.Serial(port=None, baudrate=19200, bytesize=8, parity="N",
                               stopbits=2, timeout=0.10, write_timeout=1)
        stream.dtr = stream.rts = True
        stream.port = device
        try:
            stream.open()
            if cancelled.wait(2.0):
                raise Interrupted()
            return cls(stream, cancelled)
        except BaseException:
            stream.close()
            raise

    def close(self):
        self.stream.close()

    def _send(self, request):
        if self.cancelled.wait(0.006):
            raise Interrupted()
        self.stream.reset_input_buffer()
        self.stream.write(request + crc16(request))
        self.stream.flush()
        return time.monotonic() + 1.8

    def _read(self, size, deadline):
        data = bytearray()
        while len(data) < size:
            if self.cancelled.is_set():
                raise Interrupted()
            if time.monotonic() >= deadline:
                raise ProtocolError("探头未及时响应。请检查供电、接线和串口设置。")
            data.extend(self.stream.read(size - len(data)))
        return bytes(data)

    def identify(self):
        deadline = self._send(bytes([ADDRESS, 0x2b, 0x0e, 1, 0]))
        prefix = self._read(3, deadline)
        if prefix[1] == 0xab:
            validate(prefix + self._read(2, deadline), 0x2b)
        if prefix != bytes([ADDRESS, 0x2b, 0x0e]):
            raise ProtocolError("所选端口未返回预期的探头标识。")
        frame = bytearray(prefix + self._read(5, deadline))
        if frame[3] != 1 or frame[7] > 30:
            raise ProtocolError("探头标识响应无效。")
        objects = {}
        for _ in range(frame[7]):
            header = self._read(2, deadline)
            value = self._read(header[1], deadline)
            frame.extend(header + value)
            if len(frame) > 2048:
                raise ProtocolError("探头标识过长。")
            objects[header[0]] = value.decode("utf-8", errors="replace").strip()
        validate(bytes(frame) + self._read(2, deadline), 0x2b)
        if objects.get(0) != "Vaisala" or objects.get(1) != "HMP7":
            raise ProtocolError("所选端口没有识别到 Vaisala HMP7。")
        return objects.get(2, "")

    def _registers(self, start, words):
        deadline = self._send(read_request(start, words))
        head = self._read(3, deadline)
        if head[1] == 0x83:
            validate(head + self._read(2, deadline), 3)
        if head[:2] != bytes([ADDRESS, 3]) or head[2] != words * 2:
            raise ProtocolError("探头返回的数据长度或地址不符。")
        frame = head + self._read(words * 2 + 2, deadline)
        validate(frame, 3)
        return frame[3:-2]

    def _group(self, group, output):
        start = group[0].address
        words = sum(f.words for f in group)
        key = (start, words)
        if key not in self.split:
            try:
                data = self._registers(start, words)
            except DeviceException as error:
                if len(group) == 1:
                    if error.code == 2:
                        self.unsupported.add(group[0].key)
                    return
                if error.code not in (2, 3):
                    return
                self.split.add(key)
            else:
                for field in group:
                    offset = (field.address - start) * 2
                    output[field.key] = decode(data[offset:offset + 2 * field.words], field)
                return
        for field in group:
            self._group([field], output)

    def _values(self, fields):
        output = dict.fromkeys(f.key for f in fields)
        for group in blocks(f for f in fields if f.key not in self.unsupported):
            self._group(group, output)
        return output

    def sample(self):
        values = self._values(MEASUREMENTS)
        state = self._values(STATUS)
        if time.monotonic() >= self.next_settings:
            self.settings = self._values(CONFIG)
            self.next_settings = time.monotonic() + 60
        warnings = []
        if state["online_status"] == 0:
            values = dict.fromkeys(values)
            warnings.append("探头输出锁定")
        else:
            for key, channels in (("humidity_status", ("humidity", "humidity_dew_frost")),
                                  ("temperature_status", ("temperature",)),
                                  ("dew_frost_status", ("dewpoint", "dew_frost_point"))):
                flags = state[key] or 0
                if flags and flags & (1 | 2 | 32 | 128 | 256):
                    for channel in channels:
                        values[channel] = None
                    warnings.append("部分测量未就绪")
        if state["error_status"] == 0 or state["device_status"]:
            warnings.append("请查看设备状态")
        return Sample(time.time(), values, {**self.settings, **state}, " · ".join(dict.fromkeys(warnings)))


class Reader(threading.Thread):
    """One owner for the serial handle. The GUI receives immutable-in-use snapshots."""
    def __init__(self, device, events, interval, factory=Probe.open):
        super().__init__(name="HMP7 serial reader", daemon=True)
        self.device, self.events, self.interval = device, events, interval
        self.factory = factory
        self.stop_event = threading.Event()

    def run(self):
        probe = None
        try:
            probe = self.factory(self.device, self.stop_event)
            firmware = probe.identify()
            if self.stop_event.is_set():
                return
            self.events.put(("connected", firmware))
            while not self.stop_event.is_set():
                started = time.monotonic()
                point = probe.sample()
                if self.stop_event.is_set():
                    break
                self.events.put(("sample", point))
                self.stop_event.wait(max(0, self.interval - (time.monotonic() - started)))
        except Interrupted:
            pass
        except (ProtocolError, OSError, ValueError) as error:
            if not self.stop_event.is_set():
                self.events.put(("error", str(error)))
        finally:
            try:
                if probe is not None:
                    probe.close()
            finally:
                self.events.put(("closed", None))
