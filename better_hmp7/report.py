"""Standalone printable HTML with full-session traces, generated offline."""
from dataclasses import dataclass
from html import escape
import math

from .catalog import MEASUREMENTS
from .plot import Envelope, scale
from .recording import output_file, rows


@dataclass(slots=True)
class Summary:
    low: float = math.inf
    high: float = -math.inf
    total: float = 0.0
    count: int = 0

    def add(self, value):
        if value is not None and math.isfinite(value):
            self.low = min(self.low, value)
            self.high = max(self.high, value)
            self.total += value
            self.count += 1


def svg(field, summary, envelope, first, last):
    if not summary.count:
        return "<p>本次没有有效读数</p>"
    width, height, left, right, top, bottom = 760, 174, 78, 744, 18, 135
    low, high = scale(summary.low, summary.high, field.min_span)
    span = max(0.001, envelope.end - envelope.start)
    def xy(point):
        return (left + (point[0] - envelope.start) / span * (right - left),
                bottom - (point[1] - low) / (high - low) * (bottom - top))
    out = [f'<svg viewBox="0 0 {width} {height}" role="img" aria-label="{escape(field.heading)}">']
    for n in range(4):
        y = bottom - (bottom - top) * n / 3
        value = low + (high - low) * n / 3
        out.append(f'<path stroke="#e0e6eb" d="M{left} {y:.1f}H{right}"/>'
                   f'<text x="{left-8}" y="{y+4:.1f}" text-anchor="end">{value:.{field.decimals}f}</text>')
    for segment in envelope.segments():
        coords = [xy(p) for p in segment]
        if len(coords) == 1:
            x, y = coords[0]
            out.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="2.5" fill="{field.color}"/>')
        else:
            points = " ".join(f"{x:.2f},{y:.2f}" for x,y in coords)
            out.append(f'<polyline fill="none" stroke="{field.color}" stroke-width="2" points="{points}"/>')
    out.append(f'<text x="{left}" y="161">{first:%m-%d %H:%M:%S}</text>'
               f'<text x="{right}" y="161" text-anchor="end">{last:%m-%d %H:%M:%S}</text></svg>')
    return "".join(out)


def export_report(source, destination, selected, interval):
    summaries = [Summary() for _ in MEASUREMENTS]
    first = last = None
    count = 0
    for when, local, values in rows(source):
        if first is None or when.timestamp() < first.timestamp():
            first = local
        if last is None or when.timestamp() > last.timestamp():
            last = local
        count += 1
        for stats, value in zip(summaries, values):
            stats.add(value)
    if not count:
        raise ValueError("该记录没有采样数据。")
    chosen = [(i, f) for i, f in enumerate(MEASUREMENTS) if f.key in selected]
    curves = {i: Envelope(first.timestamp(), last.timestamp(), 666) for i, _ in chosen}
    for when, _, values in rows(source):
        ts = when.timestamp()
        for i, _ in chosen:
            curves[i].add(ts, values[i])
    table = []
    for field, stats in zip(MEASUREMENTS, summaries):
        numbers = [field.show(n) for n in (stats.low, stats.total / stats.count, stats.high)] if stats.count else ["—"]*3
        table.append(f"<tr><th>{escape(field.heading)}</th><td>"+"</td><td>".join([*numbers,str(stats.count)])+"</td></tr>")
    plots = "".join(f"<section><h2>{escape(f.heading)}</h2>{svg(f,summaries[i],curves[i],first,last)}</section>"
                    for i,f in chosen)
    style = """*{box-sizing:border-box}body{font:16px/1.55 system-ui,sans-serif;color:#183340;background:#f2f5f6;margin:0}
main{max-width:880px;background:white;margin:24px auto;padding:36px;border-radius:12px}
header{display:flex;align-items:center;justify-content:space-between;gap:1rem}h1{font-size:28px;margin:0}
h2{font-size:18px}p{color:#52646d}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:right;border-bottom:1px solid #e3e8ec;padding:5px 8px}th:first-child{text-align:left}
svg{width:100%;display:block}svg text{font:12px system-ui,sans-serif;fill:#516471}
section{break-inside:avoid}button{padding:8px 14px;white-space:nowrap}small{color:#52646d}
@page{size:A4;margin:14mm}@media print{body{background:white}main{margin:0;padding:0;max-width:none}button{display:none}header{display:block}}"""
    meta = (f"{first:%Y-%m-%d %H:%M:%S %z} — {last:%Y-%m-%d %H:%M:%S %z}"
            f"　·　{count} 条记录　·　目标间隔 {interval:g} 秒")
    content = ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
               f'<title>Better HMP7 · 温湿度记录</title><style>{style}</style><main><header>'
               '<div><small>Better HMP7</small><h1>温湿度测量记录</h1></div>'
               '<button onclick="window.print()">打印 / 另存为 PDF</button></header>'
               f'<p>{meta}</p>{plots}<h2>全部测量项</h2>'
               '<table><thead><tr><th>测量项</th><th>最小</th><th>平均</th><th>最大</th><th>有效数</th></tr></thead>'
               '<tbody>'+''.join(table)+'</tbody></table></main></html>')
    with output_file(source, destination) as temp:
        temp.write_text(content, encoding="utf-8")
