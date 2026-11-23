"""Incremental, local CSV recordings and streaming XLSX export."""
import csv
from contextlib import contextmanager
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile

from .catalog import MEASUREMENTS

HEADER = ["UTC", "本地时间（含时区）", *(f.heading for f in MEASUREMENTS)]


def utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class Recording:
    def __init__(self, path):
        self.path = Path(path)
        self.count = 0
        self.stream = self.path.open("x", encoding="utf-8-sig", newline="")
        try:
            self.writer = csv.writer(self.stream)
            self.writer.writerow(HEADER)
            self.stream.flush()
        except Exception:
            self.stream.close()
            raise

    def append(self, sample):
        stamp = datetime.fromtimestamp(sample.timestamp, timezone.utc)
        self.writer.writerow([utc(sample.timestamp), stamp.astimezone().isoformat(timespec="milliseconds"),
                              *(sample.measurements.get(f.key) for f in MEASUREMENTS)])
        self.stream.flush()
        self.count += 1

    def close(self):
        self.stream.close()


def rows(path):
    with Path(path).open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.reader(stream)
        if next(reader, None) != HEADER:
            raise ValueError("所选文件的表头与记录格式不符。")
        for row in reader:
            if len(row) != len(HEADER):
                raise ValueError(f"第 {reader.line_num} 行数据不完整。")
            yield (datetime.fromisoformat(row[0]), datetime.fromisoformat(row[1]),
                   [float(cell) if cell else None for cell in row[2:]])


@contextmanager
def output_file(source, destination):
    """Only replace the requested export once the new file is fully written."""
    dest = Path(destination)
    if Path(source).resolve() == dest.resolve() or (dest.exists() and os.path.samefile(source, dest)):
        raise ValueError("导出文件需与原始 CSV 使用不同的文件名。")
    fd, temp = tempfile.mkstemp(dir=dest.parent, suffix=dest.suffix)
    os.close(fd)
    try:
        yield Path(temp)
        os.replace(temp, dest)
    finally:
        Path(temp).unlink(missing_ok=True)


def export_excel(source, destination):
    from openpyxl import Workbook
    from openpyxl.cell import WriteOnlyCell
    from openpyxl.styles import Font
    from openpyxl.utils import get_column_letter

    with output_file(source, destination) as temp:
        book = Workbook(write_only=True)
        def start_sheet(index):
            sheet = book.create_sheet("测量记录" if index == 1 else f"测量记录 {index}")
            sheet.freeze_panes = "C2"
            for i, heading in enumerate(HEADER, 1):
                sheet.column_dimensions[get_column_letter(i)].width = 28 if i <= 2 else max(16, len(heading) * 2)
            heads = [WriteOnlyCell(sheet, value=h) for h in ["UTC", "采集时的本地时间", *HEADER[2:]]]
            for cell in heads:
                cell.font = Font(bold=True, color="174879")
            sheet.append(heads)
            return sheet
        sheet = start_sheet(1)
        count = 0
        try:
            for when, local, values in rows(source):
                if count and count % 1_048_575 == 0:
                    sheet = start_sheet(count // 1_048_575 + 1)
                dates = [WriteOnlyCell(sheet, value=d.replace(tzinfo=None)) for d in (when, local)]
                for cell in dates:
                    cell.number_format = "yyyy-mm-dd hh:mm:ss.000"
                sheet.append([*dates, *values])
                count += 1
            book.save(temp)
        finally:
            book.close()
