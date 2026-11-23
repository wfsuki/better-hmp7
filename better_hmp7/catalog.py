"""Register descriptions and display formatting shared by the UI and exports."""
from dataclasses import dataclass
import json
from pathlib import Path


@dataclass(frozen=True, slots=True)
class Field:
    key: str
    name: str
    unit: str
    address: int
    words: int
    format: str
    group: str
    decimals: int
    min_span: float
    color: str
    display: str
    labels: dict | None = None
    flags: dict | None = None

    @property
    def heading(self):
        return f"{self.name} ({self.unit})" if self.unit else self.name

    def show(self, value):
        if value is None:
            return "—"
        if self.labels and str(value) in self.labels:
            return self.labels[str(value)]
        if self.display == "hex":
            return f"0x{value & 0xffffffff:08X}"
        if self.flags:
            remaining = value & 0xffffffff
            parts = []
            for bit, name in self.flags.items():
                if remaining & int(bit):
                    parts.append(name)
                    remaining &= ~int(bit)
            if remaining:
                parts.append(f"0x{remaining:X}")
            return " / ".join(parts) or str(value)
        return f"{value:.{self.decimals}f}"


FIELDS = tuple(Field(**row) for row in json.loads(Path(__file__).with_name("fields.json").read_text(encoding="utf-8")))
MEASUREMENTS = tuple(f for f in FIELDS if f.group == "measurement")
STATUS = tuple(f for f in FIELDS if f.group == "status")
CONFIG = tuple(f for f in FIELDS if f.group == "config")
BY_ADDRESS = {f.address: f for f in FIELDS}
BY_KEY = {f.key: f for f in FIELDS}
