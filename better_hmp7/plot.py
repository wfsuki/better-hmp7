"""Small pixel-bucket envelope used by both live and printed traces."""
from dataclasses import dataclass
import math


@dataclass(slots=True)
class Bucket:
    first: tuple
    low: tuple
    high: tuple
    last: tuple

    def add(self, point):
        self.last = point
        if point[1] < self.low[1]:
            self.low = point
        if point[1] > self.high[1]:
            self.high = point

    def points(self):
        return sorted(set((self.first, self.low, self.high, self.last)))


class Envelope:
    def __init__(self, start, end, width):
        self.start = start
        self.end = end
        self.width = max(1, int(width))
        self.parts = []
        self.current = None
        self.index = None

    def add(self, timestamp, value):
        if not self.start <= timestamp <= self.end:
            return
        if value is None or not math.isfinite(value):
            self.current = None
            self.index = None
            return
        point = (timestamp, value)
        column = int((timestamp - self.start) / max(0.001, self.end - self.start) * self.width)
        if self.current is None:
            self.current = []
            self.parts.append(self.current)
        if not self.current or self.index != column:
            self.current.append(Bucket(point, point, point, point))
            self.index = column
        else:
            self.current[-1].add(point)

    def segments(self):
        return [[point for bucket in part for point in bucket.points()] for part in self.parts]


def scale(low, high, span):
    padding = max((high - low) * 0.12, span * 0.15)
    centre = (low + high) / 2
    half = max((high - low) / 2 + padding, span / 2)
    return centre - half, centre + half


def viewport(start, end, left, width):
    duration = max(5, end - start)
    width = min(duration, max(5, width))
    right_bound = max(end, start + duration)
    left = max(start, min(right_bound - width, left))
    return left, left + width
