from __future__ import annotations

import math


def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else hi if v > hi else v


def normalize(x: float, y: float) -> tuple[float, float]:
    mag = math.hypot(x, y)
    if mag <= 1e-6:
        return 0.0, 0.0
    return x / mag, y / mag


def dist2(ax: float, ay: float, bx: float, by: float) -> float:
    dx = ax - bx
    dy = ay - by
    return dx * dx + dy * dy

