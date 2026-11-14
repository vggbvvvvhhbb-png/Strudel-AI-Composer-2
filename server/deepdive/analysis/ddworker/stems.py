# -*- coding: utf-8 -*-
"""
Стемы: активность по секциям и нормализованная кривая энергии.
"""

from __future__ import annotations

from .common import _num, np


def _activity_by_section(rms, rms_times, sections: list) -> dict:
    activity = {}
    if not sections:
        return activity
    values = []
    for section in sections:
        start_s = float(section.get("start_s") or 0.0)
        end_s = float(section.get("end_s") or 0.0)
        mask = (rms_times >= start_s) & (rms_times < end_s)
        values.append(float(np.mean(rms[mask])) if np.any(mask) else 0.0)
    peak = max(values) if values else 0.0
    for section, value in zip(sections, values):
        index = int(section.get("index", len(activity)))
        activity[str(index)] = _num(value / peak if peak > 1e-12 else 0.0, 3)
    return activity


def _energy_curve(rms, rms_times, max_points: int = 200) -> list:
    if len(rms) == 0:
        return []
    peak = float(np.max(rms))
    step = max(1, len(rms) // max_points)
    curve = []
    for index in range(0, len(rms), step):
        window = rms[index:index + step]
        value = float(np.max(window)) if len(window) else 0.0
        curve.append({
            "time_s": _num(float(rms_times[index]), 3),
            "value": _num(value / peak if peak > 1e-12 else 0.0, 3),
        })
    return curve
