"""Better HMP7 native desktop UI. All instrument I/O stays on the serial worker."""
from collections import deque
from datetime import datetime
import queue
from pathlib import Path
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import tkinter.font as tkfont

from .catalog import CONFIG, MEASUREMENTS, STATUS
from .chart import TrendChart
from .preferences import INTERVALS, preferences_file, read_preferences, save_preferences
from .probe import Reader, available_ports
from .recording import Recording, export_excel
from .report import export_report

BG, WHITE, INK, MUTED, ACCENT = "#f1f5f5", "#ffffff", "#163841", "#536d75", "#086b70"


def theme(root):
    style = ttk.Style(root)
    style.theme_use("clam")
    families = set(tkfont.families(root))
    face = next((s for s in ("Microsoft YaHei UI","PingFang SC","Noto Sans CJK SC","Segoe UI","Helvetica") if s in families),
                tkfont.nametofont("TkDefaultFont").actual("family"))
    for name in ("TkDefaultFont","TkTextFont","TkMenuFont","TkHeadingFont"):
        tkfont.nametofont(name).configure(family=face, size=10)
    root.configure(bg=BG)
    style.configure(".", font=(face,10), background=BG, foreground=INK)
    style.configure("TButton", padding=(10,6), background=WHITE, borderwidth=1, relief="flat",
                    bordercolor="#c4d3d5", lightcolor=WHITE, darkcolor=WHITE)
    style.map("TButton", background=[("active","#e5efef")],foreground=[("disabled","#849398")])
    style.configure("Accent.TButton", padding=(15,7), background=ACCENT,foreground=WHITE,bordercolor=ACCENT)
    style.map("Accent.TButton",background=[("disabled","#d4e0e1"),("active","#07575b")],
              foreground=[("disabled","#6f8084"),("!disabled",WHITE)])
    style.configure("TCombobox", padding=(5,5),fieldbackground=WHITE,arrowsize=12)
    style.map("TCombobox",fieldbackground=[("readonly",WHITE)])
    style.configure("Paper.TFrame",background=WHITE)
    style.configure("Treeview",rowheight=30,background=WHITE,fieldbackground=WHITE,borderwidth=0)
    style.configure("Treeview.Heading",font=(face,10,"bold"),background="#eaf0f1",padding=(5,6))
    style.configure("TNotebook",background=BG, borderwidth=0)
    style.configure("TNotebook.Tab",padding=(14,7),background=BG)
    style.map("TNotebook.Tab",background=[("selected",WHITE)],foreground=[("selected",ACCENT)])
    return face


class Monitor:
    def __init__(self, root, config=None, port_source=available_ports, reader_type=Reader):
        self.root, self.port_source, self.reader_type = root, port_source, reader_type
        self.config = config if config is not None else preferences_file()
        self.keys, self.interval = read_preferences(self.config)
        self.face = theme(root)
        root.title("Better HMP7")
        root.geometry("1080x740")
        root.minsize(760,550)
        self.icon = tk.PhotoImage(file=str(Path(__file__).with_name("icon.png")))
        root.iconphoto(True,self.icon)
        self.small_icon = self.icon.subsample(max(1,self.icon.width()//36))
        self.points = deque(maxlen=8000)
        self.reader = None
        self.events = queue.Queue()
        self.connected = self.closing = self.exporting = False
        self.recording = self.saved = None
        self.started_at = None
        self.record_interval = self.interval
        self.firmware = ""
        self.last = None
        self.port = tk.StringVar()
        self.period = tk.StringVar(value=f"{self.interval:g}")
        self.conn_label = tk.StringVar(value="未连接")
        self.footer = tk.StringVar(value="请选择本机串口")
        self.file_label = tk.StringVar(value="就绪")
        self.ports = {}
        self.tiles = {}
        self._layout()
        self.refresh()
        self.update_controls()
        root.protocol("WM_DELETE_WINDOW",self.close)
        root.after(45,self.poll)

    def label(self, parent, text="", *, size=10, weight="normal", fg=INK, bg=WHITE, **opts):
        return tk.Label(parent, text=text, font=(self.face,size,weight), fg=fg,bg=bg,bd=0,**opts)

    def _layout(self):
        r = self.root
        header = tk.Frame(r,bg=WHITE,padx=24,pady=12)
        header.pack(fill="x")
        tk.Label(header,image=self.small_icon,bg=WHITE).pack(side="left",padx=(0,12))
        self.label(header,"Better HMP7",size=19,weight="bold").pack(side="left")
        self.label(header,"温湿度采集",fg=MUTED).pack(side="left",padx=14)
        self.badge = self.label(header,textvariable=self.conn_label,fg=MUTED,bg="#eaf0f0",padx=10,pady=4)
        self.badge.pack(side="right")
        body = tk.Frame(r,bg=BG,padx=20,pady=12)
        body.pack(fill="both",expand=True)
        bar = tk.Frame(body,bg=BG)
        bar.pack(fill="x",pady=(0,12))
        self.label(bar,"本机串口",bg=BG).pack(side="left",padx=(0,7))
        self.port_box = ttk.Combobox(bar,textvariable=self.port,state="readonly",width=24)
        self.port_box.pack(side="left")
        self.port_box.bind("<<ComboboxSelected>>",lambda _: self.update_controls())
        self.refresh_btn = ttk.Button(bar,text="刷新",command=self.refresh)
        self.refresh_btn.pack(side="left",padx=(5,5))
        self.connect_btn = ttk.Button(bar,text="连接",style="Accent.TButton",command=self.toggle_port)
        self.connect_btn.pack(side="left")
        self.record_btn = ttk.Button(bar,text="开始记录",command=self.toggle_record)
        self.record_btn.pack(side="right")
        self.period_box = ttk.Combobox(bar,textvariable=self.period,values=[f"{v:g}" for v in INTERVALS],
                                      state="readonly",width=4)
        self.period_box.pack(side="right",padx=(4,8))
        self.period_box.bind("<<ComboboxSelected>>",self.set_interval)
        self.label(bar,"间隔 (s)",bg=BG,fg=MUTED).pack(side="right")
        tiles = tk.Frame(body,bg=BG)
        tiles.pack(fill="x",pady=(0,12))
        for i, field in enumerate(MEASUREMENTS[:4]):
            tiles.grid_columnconfigure(i,weight=1,uniform="metric")
            cell = tk.Frame(tiles,bg=WHITE,padx=13,pady=8)
            cell.grid(row=0,column=i,sticky="nsew",padx=(0 if i==0 else 6,0))
            self.label(cell,field.name,fg=MUTED).pack(anchor="w")
            line = tk.Frame(cell,bg=WHITE)
            line.pack(anchor="w")
            v = self.label(line,"—",size=23,weight="bold")
            v.pack(side="left")
            self.label(line,field.unit,fg=MUTED).pack(side="left",padx=(5,0),anchor="s",pady=(0,4))
            self.tiles[field.key] = v
        self.tabs = ttk.Notebook(body)
        self.tabs.pack(fill="both",expand=True)
        plotting = ttk.Frame(self.tabs,style="Paper.TFrame",padding=12)
        self.tabs.add(plotting,text="实时曲线")
        actions = tk.Frame(plotting,bg=WHITE)
        actions.pack(fill="x",pady=(0,5))
        self.label(actions,"趋势",size=12,weight="bold").pack(side="left")
        self.label(actions,"滚轮缩放 · 拖动平移",fg=MUTED,size=9).pack(side="left",padx=12)
        ttk.Button(actions,text="选择曲线",command=self.choose_curves).pack(side="right")
        ttk.Button(actions,text="跟随实时",command=lambda:self.chart.reset()).pack(side="right",padx=5)
        self.chart = TrendChart(plotting)
        self.chart.pack(fill="both",expand=True)
        self.tables = {}
        self.make_table("测量明细",MEASUREMENTS)
        self.make_table("设备状态与参数",(*STATUS,*CONFIG))
        footer = tk.Frame(body,bg=BG)
        footer.pack(fill="x",pady=(9,0))
        self.label(footer,textvariable=self.footer,bg=BG,fg=MUTED,size=9,anchor="w").pack(side="left",fill="x",expand=True)
        self.export_btn = ttk.Menubutton(footer,text="导出记录 ▾")
        self.export_btn.pack(side="right")
        menu = tk.Menu(self.export_btn,tearoff=False)
        menu.add_command(label="Excel 原始数据 (.xlsx)",command=lambda:self.export("xlsx"))
        menu.add_command(label="打印报告 (.html)",command=lambda:self.export("html"))
        self.export_btn.configure(menu=menu)
        self.label(footer,textvariable=self.file_label,bg=BG,fg=ACCENT,size=9).pack(side="right",padx=12)

    def make_table(self, title, fields):
        page = ttk.Frame(self.tabs,style="Paper.TFrame",padding=(10,8))
        self.tabs.add(page,text=title)
        table = ttk.Treeview(page,columns=("name","value","unit"),show="headings",selectmode="browse")
        for col,name,width in (("name","参数",240),("value","当前读数",175),("unit","单位",100)):
            table.heading(col,text=name,anchor="w")
            table.column(col,width=width,anchor="w")
        scroll = ttk.Scrollbar(page,orient="vertical",command=table.yview)
        table.configure(yscrollcommand=scroll.set)
        table.pack(side="left",fill="both",expand=True)
        scroll.pack(side="right",fill="y")
        for field in fields:
            table.insert("","end",iid=field.key,values=(field.name,"—",field.unit))
            self.tables[field.key] = table

    def refresh(self):
        try:
            ports = self.port_source()
        except (OSError, ValueError) as error:
            self.footer.set(f"串口列表读取失败：{error}")
            return
        self.ports = {f"{p.device}  ·  {p.description or '串口'}":p.device for p in ports}
        self.port_box["values"] = tuple(self.ports)
        if self.port.get() not in self.ports:
            self.port.set(next(iter(self.ports),""))
        self.footer.set("选择端口后点击连接" if self.ports else "未发现本机串口，请接入探头后点刷新")
        self.update_controls()

    def update_controls(self):
        self.port_box.configure(state="disabled" if self.reader else "readonly")
        self.refresh_btn.configure(state="disabled" if self.reader else "normal")
        self.connect_btn.configure(text="断开" if self.connected else "取消连接" if self.reader else "连接",
                                  state="normal" if self.reader or self.port.get() in self.ports else "disabled")
        self.period_box.configure(state="disabled" if self.recording else "readonly")
        self.record_btn.configure(text="停止记录" if self.recording else "开始记录",
                                  state="normal" if self.connected and not self.exporting else "disabled")
        self.export_btn.configure(state="normal" if self.saved and self.saved.count and not self.recording and not self.exporting else "disabled")
        self.badge.configure(fg="#07584b" if self.connected else MUTED,bg="#dcf1e7" if self.connected else "#eaf0f0")

    def store(self):
        try:
            save_preferences(self.config,self.keys,self.interval)
        except OSError:
            self.footer.set("本机偏好未能保存，本次选择仍有效")

    def set_interval(self,event=None):
        if not self.recording:
            self.interval = float(self.period.get())
            if self.reader:
                self.reader.interval = self.interval
            self.store()

    def toggle_port(self):
        if self.reader:
            self.stop_record()
            self.reader.stop_event.set()
            self.connected = False
            self.conn_label.set("正在断开")
            self.update_controls()
            return
        device = self.ports.get(self.port.get())
        if not device:
            return
        self.points.clear()
        self.chart.reset()
        self.show_point(None)
        self.conn_label.set("连接中")
        self.footer.set(f"正在识别 {device} 上的探头")
        self.reader = self.reader_type(device,self.events,self.interval)
        self.reader.start()
        self.update_controls()

    def show_point(self, point):
        self.last = point
        values = {**point.measurements,**point.parameters} if point else {}
        for field in (*MEASUREMENTS,*STATUS,*CONFIG):
            val = field.show(values.get(field.key))
            self.tables[field.key].set(field.key,"value",val)
            if field.key in self.tiles:
                self.tiles[field.key].configure(text=val)
        self.chart.display(self.points,self.keys)

    def choose_curves(self):
        dialog = tk.Toplevel(self.root)
        dialog.title("选择曲线")
        dialog.configure(bg=WHITE)
        dialog.transient(self.root)
        box = tk.Frame(dialog,bg=WHITE,padx=18,pady=15)
        box.pack(fill="both",expand=True)
        for i,field in enumerate(MEASUREMENTS):
            value = tk.BooleanVar(value=field.key in self.keys)
            def change(key=field.key,v=value):
                selected = set(self.keys)
                if v.get():
                    selected.add(key)
                else:
                    selected.discard(key)
                self.keys = [f.key for f in MEASUREMENTS if f.key in selected]
                self.store()
                self.chart.display(self.points,self.keys)
            check = tk.Checkbutton(box,text=field.heading,variable=value,command=change,bg=WHITE,activebackground=WHITE,
                                   fg=INK,selectcolor="#deefee",anchor="w")
            check.grid(row=i//2,column=i%2,sticky="w",padx=4,pady=3)
        ttk.Button(box,text="完成",command=dialog.destroy).grid(row=10,columnspan=2,sticky="e",pady=(10,0))
        dialog.grab_set()

    def toggle_record(self):
        if self.recording:
            self.stop_record()
        elif self.connected:
            desktop = Path.home()/"Desktop"
            file = filedialog.asksaveasfilename(parent=self.root,title="新建本机 CSV 记录",
                        initialdir=desktop if desktop.is_dir() else Path.home(),
                        initialfile=datetime.now().strftime("HMP7-%Y%m%d-%H%M%S.csv"),
                        defaultextension=".csv",filetypes=[("CSV","*.csv")],confirmoverwrite=False)
            if file and self.connected and not self.closing:
                try:
                    self.begin_record(Path(file))
                except FileExistsError:
                    messagebox.showinfo("已存在同名文件","请另取一个文件名，已有测量记录会保留。",parent=self.root)
                except (OSError, ValueError) as error:
                    messagebox.showerror("无法记录",str(error),parent=self.root)

    def begin_record(self, path):
        if path.suffix.lower() != ".csv":
            raise ValueError("请选择扩展名为 .csv 的新文件。")
        self.recording = Recording(path)
        self.saved = self.recording
        self.started_at = time.time()
        self.record_interval = self.interval
        self.file_label.set("记录中 · 0 条")
        self.update_controls()

    def stop_record(self):
        session, self.recording = self.recording, None
        if session is None:
            return
        try:
            session.close()
            self.file_label.set(f"已保存 {session.count} 条")
        except OSError as error:
            self.file_label.set("写盘失败")
            self.footer.set(str(error))
        self.update_controls()

    def export(self, kind):
        if not self.saved or not self.saved.count or self.recording or self.exporting:
            return
        source = self.saved.path
        dest = filedialog.asksaveasfilename(parent=self.root,title="导出测量记录",initialdir=source.parent,
                    initialfile=source.stem+"."+kind,defaultextension="."+kind,filetypes=[(kind.upper(),"*."+kind)])
        if not dest or self.closing:
            return
        if Path(dest).suffix.lower() != "."+kind:
            messagebox.showerror("扩展名不符","请选择 ."+kind+" 文件。",parent=self.root)
            return
        selected, interval = tuple(self.keys), self.record_interval
        self.exporting = True
        self.file_label.set("正在导出…")
        self.update_controls()
        def save():
            try:
                if kind=="xlsx":
                    export_excel(source,dest)
                else:
                    export_report(source,dest,selected,interval)
                result = "已导出 "+Path(dest).name
            except Exception as error:
                result = f"导出失败：{error}"
            self.events.put(("export",result))
        threading.Thread(target=save,name="HMP7 export",daemon=True).start()

    def poll(self):
        point = None
        while True:
            try:
                kind, value = self.events.get_nowait()
            except queue.Empty:
                break
            if kind=="connected":
                if self.closing or not self.reader or self.reader.stop_event.is_set():
                    continue
                self.firmware = value
                self.connected = True
                self.conn_label.set("已连接")
                self.footer.set("已识别 Vaisala HMP7 · "+(value or "固件版本未知"))
            elif kind=="sample" and self.connected:
                point = value
                self.points.append(point)
                while self.points and self.points[0].timestamp < point.timestamp-1800:
                    self.points.popleft()
                if self.recording and point.timestamp >= self.started_at:
                    try:
                        self.recording.append(point)
                        self.file_label.set(f"记录中 · {self.recording.count} 条")
                    except OSError as error:
                        self.stop_record()
                        self.file_label.set("写入失败，记录已停止")
                        self.footer.set(str(error))
                self.conn_label.set(point.warning or "已连接")
            elif kind=="error":
                self.footer.set("读取中断 · "+value)
            elif kind=="closed":
                self.stop_record()
                self.reader = None
                self.connected = False
                self.conn_label.set("未连接")
                point = None
                self.show_point(None)
                if not self.footer.get().startswith("读取中断"):
                    self.footer.set("串口已释放")
            elif kind=="export":
                self.exporting = False
                self.file_label.set(value)
            self.update_controls()
        if point:
            self.show_point(point)
        if self.closing and not self.reader and not self.exporting:
            self.root.destroy()
            return
        self.root.after(60,self.poll)

    def close(self):
        self.closing = True
        self.stop_record()
        if self.reader:
            self.reader.stop_event.set()
        self.root.withdraw()


def main():
    root = tk.Tk()
    if "--smoke-test" in sys.argv:
        root.withdraw()
    app = Monitor(root)
    if "--smoke-test" in sys.argv:
        root.after(80,app.close)
    root.mainloop()


if __name__ == "__main__":
    main()
