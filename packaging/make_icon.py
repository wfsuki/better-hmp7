"""Regenerate the original application icons with Pillow (build-time only)."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
assets = ROOT / "packaging" / "assets"
assets.mkdir(exist_ok=True)
image = Image.new("RGBA", (1024,1024))
d = ImageDraw.Draw(image)
d.rounded_rectangle((34,34,990,990),radius=214,fill="#103f49")
for y in (321,511,702):
    d.line((178,y,846,y),fill="#285660",width=11)
def trace(points, color, width):
    d.line(points,fill=color,width=width,joint="curve")
    r=width//2
    for x,y in points:
        d.ellipse((x-r,y-r,x+r,y+r),fill=color)
trace([(182,663),(306,663),(437,350),(550,607),(656,485),(832,485)],"#65dfbf",56)
d.ellipse((770,212,851,293),fill="#f8c889")
image.resize((144,144),Image.Resampling.LANCZOS).save(ROOT/"better_hmp7"/"icon.png")
image.save(assets/"icon.ico",sizes=[(n,n) for n in (16,24,32,48,64,128,256)])
image.save(assets/"icon.icns")
image.resize((256,256),Image.Resampling.LANCZOS).save(assets/"icon-256.png")
