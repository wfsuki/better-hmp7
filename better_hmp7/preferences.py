import json
import os
from pathlib import Path
import sys
import tempfile

from .catalog import MEASUREMENTS

DEFAULT_CURVES = ("temperature", "humidity")
INTERVALS = tuple(i / 2 for i in range(1, 11))


def preferences_file():
    home = Path.home()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or home / "AppData/Local")
    elif sys.platform == "darwin":
        base = home / "Library/Application Support"
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config")
    return base / "BetterHMP7" / "preferences.json"


def read_preferences(path):
    try:
        options = json.loads(path.read_text(encoding="utf-8"))
        keys = options["curves"]
        interval = options["interval"]
        if not isinstance(keys, list) or type(interval) not in (float, int) or interval not in INTERVALS:
            raise ValueError()
        return [f.key for f in MEASUREMENTS if f.key in keys], float(interval)
    except (OSError, KeyError, TypeError, ValueError):
        return list(DEFAULT_CURVES), 1.0


def save_preferences(path, keys, interval):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, mode="w", encoding="utf-8", delete=False) as file:
        tmp = Path(file.name)
        try:
            json.dump({"curves": list(keys), "interval": interval}, file)
            file.close()
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
