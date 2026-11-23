from datetime import datetime
import math
from tkinter import Canvas, ttk

from .catalog import MEASUREMENTS
from .plot import Envelope, scale, viewport

INK = "#183742"
MUTED = "#5b707a"
GRID = "#e0e8e9"


class TrendChart(ttk.Frame):
    def __init__(self, parent):
        super().__init__(parent, style="Paper.TFrame")
        self.canvas = Canvas(self, background="white", highlightthickness=0, width=500, height=205)
        self.scroll = ttk.Scrollbar(self, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=self.scroll.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.points = ()
        self.keys = ()
        self.bounds = None
        self.anchor = None
        self.canvas.bind("<Configure>", lambda _: self.redraw())
        self.canvas.bind("<MouseWheel>", lambda e: self.zoom(e.x, 0.8 if e.delta > 0 else 1.25))
        self.canvas.bind("<Button-4>", lambda e: self.zoom(e.x, 0.8))
        self.canvas.bind("<Button-5>", lambda e: self.zoom(e.x, 1.25))
        self.canvas.bind("<ButtonPress-1>", self.press)
        self.canvas.bind("<B1-Motion>", self.drag)
        self.canvas.bind("<ButtonRelease-1>", lambda _: setattr(self,"anchor",None))
        self.canvas.bind("<Double-Button-1>", lambda _: self.reset())

    def display(self, points, keys):
        self.points, self.keys = points, keys
        self.redraw()

    def reset(self):
        self.anchor = self.bounds = None
        self.redraw()

    def limits(self):
        first, last = self.points[0].timestamp, self.points[-1].timestamp
        return first, max(last, first + 5)

    def window(self):
        first, last = self.limits()
        if self.bounds is None:
            return max(first, last - 300), last
        return viewport(first, last, self.bounds[0], self.bounds[1]-self.bounds[0])

    def zoom(self, pixel, factor):
        if not self.points:
            return
        left, right = self.window()
        fraction = min(1, max(0, (pixel-84) / max(1, self.canvas.winfo_width()-115)))
        width = min(self.limits()[1]-self.limits()[0], max(5, (right-left)*factor))
        self.bounds = viewport(*self.limits(), left + (right-left-width)*fraction, width)
        self.redraw()

    def press(self, event):
        if self.points:
            self.anchor = (event.x, self.window())

    def drag(self, event):
        if self.anchor is None or not self.points:
            return
        x, (left, right) = self.anchor
        width = right-left
        movement = (x-event.x) / max(1, self.canvas.winfo_width()-115) * width
        self.bounds = viewport(*self.limits(), left+movement, width)
        self.redraw()

    def redraw(self):
        c = self.canvas
        c.delete("all")
        width = max(200, c.winfo_width())
        height = max(100, c.winfo_height())
        selected = [f for f in MEASUREMENTS if f.key in self.keys]
        total = max(height, len(selected)*117) if self.points else height
        if total > height and not self.scroll.winfo_manager():
            self.scroll.pack(side="right", fill="y")
        elif total <= height and self.scroll.winfo_manager():
            self.scroll.pack_forget()
        c.configure(scrollregion=(0,0,width,total))
        if not self.points or not selected:
            c.create_text(width/2,height/2,fill=MUTED,text="接入探头后显示实时曲线" if not self.points else "请选择要显示的曲线")
            return
        start, end = self.window()
        lane = total/len(selected)
        visible = [p for p in self.points if start <= p.timestamp <= end]
        left, right = 84, max(104, width-30)
        for i, field in enumerate(selected):
            top, bottom = lane*i+32, lane*(i+1)-22
            c.create_text(14, lane*i+12, anchor="w", fill=INK, text=field.heading)
            vals = [p.measurements.get(field.key) for p in visible]
            valid = [v for v in vals if v is not None and math.isfinite(v)]
            for n in range(3):
                y = bottom - (bottom-top)*n/2
                c.create_line(left,y,right,y,fill=GRID)
            if not valid:
                c.create_text((left+right)/2,(top+bottom)/2,text="暂无有效读数",fill=MUTED)
                continue
            low, high = scale(min(valid),max(valid),field.min_span)
            for n in range(3):
                c.create_text(left-8,bottom-(bottom-top)*n/2, anchor="e",fill=MUTED,
                              text=f"{low+(high-low)*n/2:.{field.decimals}f}")
            env = Envelope(start,end,right-left)
            for p, value in zip(visible, vals):
                env.add(p.timestamp, value)
            for segment in env.segments():
                xy = [(left+(x-start)/(end-start)*(right-left), bottom-(y-low)/(high-low)*(bottom-top)) for x,y in segment]
                if len(xy)==1:
                    x,y = xy[0]
                    c.create_oval(x-2,y-2,x+2,y+2,fill=field.color,outline="")
                else:
                    c.create_line(*[v for point in xy for v in point],fill=field.color,width=2)
            for x,t,anchor in ((left,start,"w"),(right,end,"e")):
                c.create_text(x,bottom+10,anchor=anchor,fill=MUTED,text=datetime.fromtimestamp(t).strftime("%H:%M:%S"))
