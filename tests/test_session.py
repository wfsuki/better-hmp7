from pathlib import Path
import tempfile
import unittest

from openpyxl import load_workbook
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
