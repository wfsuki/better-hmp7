import base64
import csv
from pathlib import Path
import re
import tempfile
import time
from types import SimpleNamespace
import unittest

from openpyxl import load_workbook
import webview

from better_hmp7.app import create_dashboard, web_engine
from better_hmp7.catalog import CONFIG, MEASUREMENTS, STATUS
from better_hmp7.desktop import DesktopAPI
from better_hmp7.probe import Sample


class FixtureProbe:
    def __init__(self):
        self.unsupported = set()
        self.unplugged = self.closed = False
        self.sequence = 0

    def identify(self):
        return "test"

    def sample(self):
        if self.unplugged:
            raise OSError("USB disconnected")
        self.sequence += 1
        values = {field.key: 20 + i + self.sequence / 10 for i, field in enumerate(MEASUREMENTS)}
        values["water_mass_fraction"] = None
        return Sample(time.time(), values, {field.key: 0 for field in (*STATUS, *CONFIG)})

    def close(self):
        self.closed = True


class DashboardTests(unittest.TestCase):
    def test_native_dashboard_session(self):
        with tempfile.TemporaryDirectory() as directory:
            self.exercise_session(Path(directory))

    def exercise_session(self, folder):
        csv_file = folder / "capture.csv"
        workbook = folder / "readings.xlsx"
        report = folder / "report.html"
        destinations = {"recording-file": csv_file, "csv": workbook, "report": report}
        port = SimpleNamespace(device="TEST", description="Instrument fixture", vid=0x1843, pid=0x0200)
        probe = FixtureProbe()
        api = DesktopAPI(port_source=lambda: [port], probe_factory=lambda *_: probe, config=folder / "settings.json",
                         picker=lambda kind, _: destinations[kind])
        win = create_dashboard(api)
        errors = []
        js = win.evaluate_js

        def until(predicate, timeout=12):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                if predicate():
                    return
                time.sleep(.08)
            self.fail(f"Dashboard timed out: {predicate.__doc__ or predicate!r}")

        def wait_js(expression):
            until(lambda: js(expression))

        def click(element):
            js(f"document.getElementById('{element}').click(); true")

        def record_count(path):
            with path.open(encoding="utf-8-sig", newline="") as stream:
                return len(list(csv.reader(stream))) - 1

        def drive():
            try:
                wait_js("document.body.dataset.desktopReady === 'true'")
                self.assertIsNone(webview.http.global_server)
                self.assertEqual(js("document.querySelectorAll('[data-metric]').length"), 18)
                self.assertEqual(js("document.querySelectorAll('.parameter-item').length"), 20)
                self.assertEqual(js("document.querySelectorAll('[data-curve]:checked').length"), 2)
                click("connect-button")
                wait_js("document.getElementById('local-port').value === 'TEST'")
                click("confirm-port")
                wait_js("currentState.latest !== null && HMP7Serial.connected")
                js("document.querySelector('[data-metric=dewpoint]').click(); true")
                wait_js("document.querySelector('[data-curve=dewpoint]').checked")
                self.assertEqual(js("document.querySelectorAll('.lane-title').length"), 3)
                self.assertEqual(js("document.getElementById('value-water_mass_fraction').textContent"), "—")
                js("const el=document.getElementById('sampling-interval'); el.value='500'; el.dispatchEvent(new Event('change')); true")
                until(lambda: api.preferences()["interval"] == .5 and "dewpoint" in api.preferences()["curves"])
                click("folder-button")
                wait_js("selectedCsvHandle !== null")
                self.assertFalse(csv_file.exists())
                click("recording-button")
                wait_js("recording && document.getElementById('sampling-interval').disabled")
                wait_js("recordedPoints.length >= 4")
                click("recording-button")
                wait_js("!recording")
                until(lambda: api._csv is None)
                count = record_count(csv_file)
                self.assertGreaterEqual(count, 4)
                wait_js("currentState.latest.ts > recordedPoints.at(-1).ts")
                click("nav-history")
                wait_js("chartPoints() === recordedPoints && currentHistory.points.length > 1")
                js("const plot=document.getElementById('main-chart'); const rect=plot.getBoundingClientRect();"
                   "plot.dispatchEvent(new WheelEvent('wheel',{clientX:rect.left+rect.width*.5,deltaY:-180,cancelable:true})); true")
                wait_js("customBounds !== null")
                click("export-csv-button")
                until(lambda: workbook.exists())
                wait_js("!fileBusy && !pickerBusy")
                click("export-button")
                until(lambda: report.exists())
                wait_js("!fileBusy && !pickerBusy")
                click("reset-view")
                wait_js("customBounds === null")
                click("nav-live")
                wait_js("chartPoints() === previewPoints && currentHistory.points.at(-1).ts > recordedPoints.at(-1).ts")
                book = load_workbook(workbook)
                try:
                    self.assertEqual(book.sheetnames, ["原始数据", "说明"])
                    self.assertEqual(book.active.max_row, count + 1)
                    self.assertEqual(book.active.max_column, 20)
                    self.assertTrue(book.active["A2"].is_date)
                    self.assertGreater(book.active.column_dimensions["A"].width, 22)
                    self.assertIsNone(book.active.cell(2, 20).value)
                finally:
                    book.close()
                html = report.read_text(encoding="utf-8")
                self.assertEqual(html.count('<section class="chart">'), 3)
                self.assertIn(f"有效写入 CSV：{count} 条", html)
                self.assertIn("Better HMP7</strong>", html)
                self.assertIn(".report-print{display:none!important}", html)
                image = re.search(r'<img alt="" src="data:image/png;base64,([^"]+)"', html)
                self.assertIsNotNone(image)
                self.assertEqual(base64.b64decode(image[1]), (Path(__file__).resolve().parents[1] / "better_hmp7/icon.png").read_bytes())
                next_file = folder / "unplug.csv"
                destinations["recording-file"] = next_file
                click("recording-button")
                wait_js("recording && recordedPoints.length >= 2")
                probe.unplugged = True
                wait_js("!recording && !HMP7Serial.connected")
                until(lambda: probe.closed and api._csv is None)
                self.assertGreaterEqual(record_count(next_file), 2)
                self.assertEqual(record_count(csv_file), count)
            except BaseException as error:
                errors.append(error)
            finally:
                win.destroy()

        webview.start(drive, gui=web_engine(), http_server=False, private_mode=True)
        if errors:
            raise errors[0]

    def test_existing_recording_and_interrupted_export(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            file = folder / "keep.csv"
            file.write_bytes(b"existing")
            output = folder / "report.html"
            output.write_bytes(b"previous")
            api = DesktopAPI(config=folder / "prefs.json", picker=lambda kind, _: file if kind == "recording-file" else output)
            token = api.choose_file("recording-file", "test.csv")["token"]
            with self.assertRaises(ValueError):
                api.begin_csv(token, "new")
            token = api.choose_file("report", "test.html")["token"]
            api.begin_export("report", token)
            api.export_chunk(token, base64.b64encode(b"partial").decode())
            api._shutdown()
            self.assertEqual(file.read_bytes(), b"existing")
            self.assertEqual(output.read_bytes(), b"previous")
            self.assertFalse(list(folder.glob(".hmp7-*")))
