"""Native serial and file operations for the offline instrument dashboard."""

import base64
from dataclasses import dataclass
import os
from pathlib import Path
import tempfile
import threading
import uuid
import webbrowser

from .preferences import INTERVALS, preferences_file, read_preferences, save_preferences
from .catalog import MEASUREMENTS
from .probe import Interrupted, Probe, available_ports


FILE_TYPES = {
    "recording-file": (".csv", "CSV (*.csv)"),
    "csv": (".xlsx", "Excel (*.xlsx)"),
    "report": (".html", "HTML (*.html)"),
}
DRIVER_URL = "https://www.vaisala.com/en/products/software/swinsight"


@dataclass
class SelectedFile:
    token: str
    path: Path


class DesktopAPI:
    def __init__(self, *, port_source=available_ports, probe_factory=Probe.open, config=None, picker=None):
        self._port_source = port_source
        self._probe_factory = probe_factory
        self._config = config or preferences_file()
        self._picker = picker
        self._window = None
        self._state = threading.Lock()
        self._io = threading.Lock()
        self._disk = threading.RLock()
        self._closed = False
        self._cancel = self._probe = None
        self._selected = {}
        self._csv = self._csv_token = self._last_csv = None
        self._exports = {}

    def ports(self):
        return [{"device": p.device, "description": p.description or "", "vid": p.vid, "pid": p.pid}
                for p in self._port_source()]

    def connect_port(self, device):
        port = next((p for p in self.ports() if p["device"] == device), None)
        if port is None:
            raise ValueError("该串口已不在本机，请刷新列表。")
        event = threading.Event()
        with self._state:
            if self._closed or self._cancel is not None:
                raise RuntimeError("串口连接正在使用。")
            self._cancel = event
        with self._io:
            probe = None
            try:
                if event.is_set():
                    raise Interrupted()
                probe = self._probe_factory(device, event)
                firmware = probe.identify()
                if event.is_set():
                    raise Interrupted()
                self._probe = probe
                return {"vendor": "Vaisala", "model": "HMP7", "firmware": firmware, "port": device,
                        "usbVendorId": port["vid"], "usbProductId": port["pid"]}
            except BaseException:
                try:
                    if probe is not None:
                        probe.close()
                finally:
                    with self._state:
                        if self._cancel is event:
                            self._cancel = None
                raise

    def read_sample(self):
        with self._io:
            if self._probe is None:
                raise RuntimeError("探头已断开。")
            sample = self._probe.sample()
            unavailable = {k: "当前固件不支持此项" for k in self._probe.unsupported}
            if sample.warning:
                for key, value in sample.measurements.items():
                    if value is None:
                        unavailable.setdefault(key, sample.warning)
            return {"timestamp": sample.timestamp, **sample.measurements, "parameters": sample.parameters,
                    "unavailable": unavailable, "warnings": [sample.warning] if sample.warning else []}

    def disconnect_port(self):
        with self._state:
            event = self._cancel
            if event is None:
                return
            event.set()
        with self._io:
            with self._state:
                if self._cancel is not event:
                    return
                probe, self._probe, self._cancel = self._probe, None, None
            if probe is not None:
                probe.close()

    def preferences(self):
        with self._disk:
            keys, interval = read_preferences(self._config)
        return {"curves": keys, "interval": interval}

    def set_preferences(self, keys, interval):
        if not isinstance(keys, list) or interval not in INTERVALS:
            raise ValueError("采样设置无效。")
        keys = [f.key for f in MEASUREMENTS if f.key in keys]
        with self._disk:
            save_preferences(self._config, keys, interval)

    def open_driver_page(self):
        return webbrowser.open(DRIVER_URL)

    def choose_file(self, kind, name):
        suffix, label = FILE_TYPES[kind]
        name = Path(str(name)).name
        if not name.lower().endswith(suffix):
            raise ValueError("文件类型不符。")
        if self._picker is not None:
            result = self._picker(kind, name)
        else:
            import webview
            desktop = Path.home() / "Desktop"
            result = self._window.create_file_dialog(webview.FileDialog.SAVE,
                       directory=str(desktop if desktop.is_dir() else Path.home()),
                       save_filename=name, file_types=(label,))
        if not result:
            return None
        path = Path(result[0] if isinstance(result, (list, tuple)) else result)
        if not path.suffix:
            path = path.with_suffix(suffix)
        if path.suffix.lower() != suffix:
            raise ValueError(f"请选择 {suffix} 文件。")
        with self._disk:
            if self._closed:
                raise RuntimeError("窗口已关闭。")
            selected = SelectedFile(uuid.uuid4().hex, path)
            self._selected[kind] = selected
            return {"token": selected.token, "name": path.name, "kind": kind}

    def _take(self, kind, token):
        selected = self._selected.get(kind)
        if not selected or selected.token != token:
            raise ValueError("请重新选择保存文件。")
        del self._selected[kind]
        return selected.path

    def begin_csv(self, token, header):
        with self._disk:
            if self._closed or self._csv is not None:
                raise RuntimeError("已有记录正在写入，或窗口已关闭。")
            path = self._take("recording-file", token)
            try:
                stream = path.open("x", encoding="utf-8", newline="")
            except FileExistsError:
                raise ValueError("此文件已存在，请为本次记录选择新的 CSV 文件名。") from None
            try:
                stream.write(header)
                stream.flush()
            except BaseException:
                stream.close()
                raise
            self._csv, self._csv_token, self._last_csv = stream, token, path

    def append_csv(self, token, row):
        with self._disk:
            if self._csv is None or self._csv_token != token:
                raise RuntimeError("记录文件已关闭。")
            self._csv.write(row)
            self._csv.flush()

    def end_csv(self, token):
        with self._disk:
            if self._csv is not None and self._csv_token == token:
                stream, self._csv, self._csv_token = self._csv, None, None
                stream.close()

    def begin_export(self, kind, token):
        if kind not in ("report", "csv"):
            raise ValueError("不支持的导出格式。")
        with self._disk:
            if self._closed:
                raise RuntimeError("窗口已关闭。")
            path = self._take(kind, token)
            if self._last_csv and (path.resolve() == self._last_csv.resolve() or
                    (path.exists() and self._last_csv.exists() and os.path.samefile(path, self._last_csv))):
                raise ValueError("请另选文件，保留原始 CSV。")
            output = tempfile.NamedTemporaryFile(dir=path.parent, prefix=".hmp7-", delete=False)
            self._exports[token] = (path, output)

    def export_chunk(self, token, encoded):
        data = base64.b64decode(encoded, validate=True)
        with self._disk:
            self._exports[token][1].write(data)

    def end_export(self, token, commit):
        with self._disk:
            export = self._exports.pop(token, None)
            if export is None:
                return
            dest, output = export
            temp = Path(output.name)
            try:
                output.close()
                if commit:
                    os.replace(temp, dest)
            finally:
                temp.unlink(missing_ok=True)

    def _shutdown(self, *_):
        with self._state:
            self._closed = True
        try:
            self.disconnect_port()
        finally:
            with self._disk:
                self.end_csv(self._csv_token)
                for token in list(self._exports):
                    self.end_export(token, False)
