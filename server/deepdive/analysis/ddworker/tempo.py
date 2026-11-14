# -*- coding: utf-8 -*-
"""
Темп: основной BPM, кандидаты (half/double time) и стабильность по окнам.
"""

from __future__ import annotations

import math

from .common import HOP, _clamp, _librosa_version, _mod, _num, np


def _grid_fit(onset_times: np.ndarray, bpm: float, tolerance_s: float = 0.07) -> float:
    """Доля онсетов, попавших на сетку данного темпа."""
    if bpm is None or bpm <= 0 or len(onset_times) == 0:
        return 0.0
    period = 60.0 / bpm
    if period <= 0:
        return 0.0
    phase = np.mod(np.asarray(onset_times, dtype=np.float64), period)
    distance = np.minimum(phase, period - phase)
    return float(np.mean(distance <= tolerance_s))


def _tempo_stability(y, sr: int) -> float:
    """Насколько темп стабилен по окнам: 1 — ровный, 0 — скачет."""
    librosa = _mod("librosa")
    duration = len(y) / float(sr)
    if duration < 40:
        return 0.5
    window_s = 30.0
    stride_s = max(10.0, window_s / 2.0)
    starts = list(np.arange(0.0, max(1.0, duration - window_s), stride_s))
    values = []
    for start in starts:
        chunk = y[int(start * sr): int((start + window_s) * sr)]
        if len(chunk) < sr * 5:
            continue
        try:
            tempo, _ = librosa.beat.beat_track(y=chunk, sr=sr)
            value = float(np.atleast_1d(tempo)[0])
            if math.isfinite(value) and value > 0:
                values.append(value)
        except Exception:
            continue
    if len(values) < 2:
        return 0.4
    spread = float(np.std(values))
    return _clamp(1.0 - spread / 8.0)


def analyze_tempo(y, sr: int) -> dict:
    librosa = _mod("librosa")
    method = f"librosa.beat.beat_track ({_librosa_version()}); сетка онсетов + стабильность по окнам"
    try:
        tempo_value, beats = librosa.beat.beat_track(y=y, sr=sr)
        bpm = float(np.atleast_1d(tempo_value)[0])
    except Exception as exc:
        return {
            "bpm": None,
            "candidates": [],
            "confidence": 0.0,
            "method": method,
            "evidence": [f"beat_track не отработал: {type(exc).__name__}: {exc}"],
        }

    if not math.isfinite(bpm) or bpm <= 0:
        return {
            "bpm": None,
            "candidates": [],
            "confidence": 0.0,
            "method": method,
            "evidence": ["beat_track вернул нечисловой темп"],
        }

    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr)
        onset_times = librosa.onset.onset_detect(
            onset_envelope=onset_env, sr=sr, units="time", hop_length=HOP
        )
    except Exception:
        onset_times = np.array([], dtype=np.float64)

    fit_primary = _grid_fit(onset_times, bpm)
    fit_half = _grid_fit(onset_times, bpm / 2.0)
    fit_double = _grid_fit(onset_times, bpm * 2.0)
    stability = _tempo_stability(y, sr)

    confidence = _clamp(0.5 * fit_primary + 0.5 * stability)
    candidates = [
        {"bpm": _num(bpm, 3), "kind": "primary", "confidence": _num(confidence)},
        {"bpm": _num(bpm / 2.0, 3), "kind": "half_time", "confidence": _num(_clamp(0.85 * fit_half))},
        {"bpm": _num(bpm * 2.0, 3), "kind": "double_time", "confidence": _num(_clamp(0.85 * fit_double))},
    ]

    evidence = [
        f"librosa.beat.beat_track: {bpm:.2f} BPM, битов в сетке: {len(beats)}",
        f"онсетов на основной сетке: {fit_primary:.2f} (доля)",
        f"половинная сетка: {fit_half:.2f}, удвоенная сетка: {fit_double:.2f}",
        f"стабильность темпа по окнам: {stability:.2f}",
    ]
    if len(onset_times) == 0:
        evidence.append("онсеты не детектированы — уверенность опирается только на сетку битов")

    return {
        "bpm": _num(bpm, 3),
        "candidates": candidates,
        "confidence": _num(confidence),
        "method": method,
        "evidence": evidence,
    }
