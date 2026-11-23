from pathlib import Path
import tempfile
import time
import tkinter as tk
from types import SimpleNamespace
import unittest

from openpyxl import load_workbook
from better_hmp7.app import Monitor
from better_hmp7.plot import Envelope
from better_hmp7.preferences import read_preferences, save_preferences
from better_hmp7.probe import Sample
from better_hmp7.recording import Recording, export_excel, rows
from better_hmp7.report import export_report


class SessionTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.folder=Path(t.name)

    def test_export_whole_recording_and_missing_values(self):
        csv=self.folder/"session.csv"
        record=Recording(csv)
        for i,v in enumerate([20,22,None,18,24]):
            record.append(Sample(1700000000+i,{"temperature":v,"humidity":44},{}))
        record.close()
        with self.assertRaises(FileExistsError):
            Recording(csv)
        data=list(rows(csv))
        self.assertEqual(len(data),5)
        self.assertIsNone(data[2][2][0])
        self.assertEqual(len(data[0][2]),18)
        xlsx=self.folder/"sample.xlsx"
        export_excel(csv,xlsx)
        b=load_workbook(xlsx)
        try:
            s=b.active
            self.assertEqual(s["C6"].value,24)
            self.assertTrue(s["A2"].is_date)
            self.assertEqual(s.freeze_panes,"C2")
            self.assertGreater(s.column_dimensions["A"].width,22)
        finally:
            b.close()
        report=self.folder/"session.html"
        export_report(csv,report,["temperature"],1.0)
        html=report.read_text(encoding="utf-8")
        self.assertEqual(html.count("<polyline"),2)
        self.assertIn("5 条记录",html)
        self.assertEqual(html.count('<svg '),1)
        self.assertNotIn("http://",html)
        with self.assertRaises(ValueError):
            export_excel(csv,csv)
        self.assertEqual(len(list(rows(csv))),5)

    def test_peaks_gaps_and_preferences(self):
        env=Envelope(0,100,1)
        for t,y in enumerate((2,20,-3,6,None,4)):
            env.add(t,y)
        self.assertEqual(env.segments(),[[(0,2),(1,20),(2,-3),(3,6)],[(5,4)]])
        opts=self.folder/"prefs.json"
        save_preferences(opts,["dewpoint"],2.5)
        self.assertEqual(read_preferences(opts),(["dewpoint"],2.5))
        opts.write_text("null")
        self.assertEqual(read_preferences(opts),(["temperature","humidity"],1.0))

    def test_gui_connect_record_disconnect_and_close(self):
        root=tk.Tk()
        root.withdraw()
        class Reader:
            def __init__(r,port,events,interval):
                import threading
                r.stop_event=threading.Event()
                r.events=events
            def start(r):
                r.events.put(("connected","test-fw"))
        app=Monitor(root,config=self.folder/"prefs.json",
                    port_source=lambda:[SimpleNamespace(device="TEST",description="fixture")],reader_type=Reader)
        def wait_for(check):
            deadline=time.monotonic()+3
            while not check() and time.monotonic()<deadline:
                root.update()
                time.sleep(.01)
            self.assertTrue(check())
        try:
            app.connect_btn.invoke()
            wait_for(lambda:app.connected)
            dest=self.folder/"ui.csv"
            app.begin_record(dest)
            self.assertEqual(str(app.period_box["state"]),"disabled")
            app.events.put(("sample",Sample(time.time()+0.05,{"temperature":24.5,"humidity":48},{})))
            wait_for(lambda:app.saved.count==1)
            self.assertEqual(app.tiles["temperature"]["text"],"24.50")
            app.events.put(("error","测试断线"))
            app.events.put(("closed",None))
            wait_for(lambda:app.reader is None)
            self.assertIsNone(app.recording)
            self.assertTrue(app.saved.stream.closed)
            self.assertEqual(len(list(rows(dest))),1)
            self.assertIn("读取中断",app.footer.get())
        finally:
            app.close()
            if app.reader:
                app.events.put(("closed", None))
            root.mainloop()
