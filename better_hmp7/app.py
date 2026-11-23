"""Open the original dashboard in an offline native window."""
import base64
import sys
import time
from pathlib import Path

import webview

from .desktop import DesktopAPI

UI = Path(__file__).with_name("ui")
SCRIPTS = ("metrics.js", "chart-view.js", "desktop.js", "xlsx.js", "app.js")


def dashboard_html():
    page = (UI / "index.html").read_text(encoding="utf-8")
    style = (UI / "style.css").read_text(encoding="utf-8")
    icon = base64.b64encode(Path(__file__).with_name("icon.png").read_bytes()).decode("ascii")
    page = page.replace("<!-- dashboard styles -->", f"<style>{style}</style>")
    scripts = []
    for name in SCRIPTS:
        code = (UI / name).read_text(encoding="utf-8").replace("</script", "<\\/script")
        scripts.append(f"<script>{code}</script>")
    return page.replace("<!-- dashboard scripts -->", "\n".join(scripts)).replace("{{PROJECT_ICON}}", icon)


def create_dashboard(api=None, **options):
    api = api or DesktopAPI()
    settings = dict(width=1480, height=940, min_size=(780, 540), background_color="#f5f7fa")
    settings.update(options)
    window = webview.create_window("Better HMP7 · 温湿度监测", html=dashboard_html(), js_api=api, **settings)
    api._window = window
    window.events.closing += api._shutdown
    return window


def web_engine():
    if sys.platform == "win32":
        return "edgechromium"
    if sys.platform.startswith("linux"):
        return "gtk"
    return None


def main():
    check = "--smoke-test" in sys.argv
    window = create_dashboard(maximized=not check)
    errors = []

    def verify():
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                ready = window.evaluate_js("document.body.dataset.desktopReady === 'true'")
                if ready:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Dashboard bridge did not initialize")
            result = window.evaluate_js("[document.querySelectorAll('[data-metric]').length,"
                                        "document.querySelectorAll('[data-curve]').length,"
                                        "document.querySelectorAll('.parameter-item').length]")
            if result != [18, 18, 20]:
                raise RuntimeError(f"Dashboard incomplete: {result}")
        except Exception as error:
            errors.append(error)
        finally:
            window.destroy()

    webview.start(verify if check else None, gui=web_engine(), http_server=False, private_mode=True)
    if errors:
        raise RuntimeError("Packaged dashboard verification failed") from errors[0]


if __name__ == "__main__":
    main()
