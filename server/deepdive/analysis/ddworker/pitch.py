# -*- coding: utf-8 -*-
"""
Питч баса: pyin (основной путь) → piptrack (запасной), ноты по MIDI.
"""

from __future__ import annotations

import math
import threading

from .common import (
    HOP,
    MAX_NOTE_F0_HZ,
    MIN_NOTE_CONFIDENCE,
    MIN_NOTE_DURATION_S,
    MIN_NOTE_F0_HZ,
    _librosa_version,
    _mod,
    _note_name,
    _num,
    np,
)


def _call_with_timeout(func, timeout_s: float):
    """Запуск функции с таймаутом: вернуть (значение, ошибка)."""
    box: dict = {}

    def runner():
        try:
            box["value"] = func()
        except Exception as exc:  # noqa: BLE001 — ошибка пробрасывается вызывающему
            box["error"] = exc

    thread = threading.Thread(target=runner, daemon=True)
    thread.start()
    thread.join(timeout_s)
    if thread.is_alive():
        return None, None
    if "error" in box:
        return None, box["error"]
    return box.get("value"), None


def _midi_from_f0(f0: float) -> float:
    return 69.0 + 12.0 * math.log2(f0 / 440.0)


def _notes_from_frames(times, freqs, confidences, voiced_flags, frame_seconds: float):
    """Группировка воксельных кадров в ноты (допуск — один MIDI-полутон)."""
    notes = []
    current = None
    for index, time_s in enumerate(times):
        f0 = freqs[index]
        voiced = bool(voiced_flags[index])
        if not voiced or not math.isfinite(f0) or f0 <= 0:
            if current is not None:
                notes.append(current)
                current = None
            continue
        midi_float = _midi_from_f0(f0)
        midi = int(round(midi_float))
        confidence = float(confidences[index])
        if current is None or midi != current["midi"]:
            if current is not None:
                notes.append(current)
            current = {
                "start_frame": index,
                "end_frame": index,
                "midi": midi,
                "f0_sum": f0,
                "conf_sum": confidence,
                "count": 1,
            }
        else:
            current["end_frame"] = index
            current["f0_sum"] += f0
            current["conf_sum"] += confidence
            current["count"] += 1
    if current is not None:
        notes.append(current)

    result = []
    for note in notes:
        # Длительность считаем по числу кадров: time_s последнего кадра — это
        # его начало, а не конец.
        duration_s = float(note["count"] * frame_seconds)
        confidence = note["conf_sum"] / max(1, note["count"])
        f0 = note["f0_sum"] / max(1, note["count"])
        result.append({
            "time_s": float(times[note["start_frame"]]),
            "duration_s": duration_s,
            "midi": int(note["midi"]),
            "note_name": _note_name(int(note["midi"])),
            "f0_hz": f0,
            "confidence": confidence,
        })
    return result


def analyze_bass_pitch(y, sr: int) -> dict:
    """Питч-трек баса: pyin (основной) → piptrack (запасной, если pyin медленный)."""
    librosa = _mod("librosa")
    duration = len(y) / float(sr)

    f0 = None
    voiced_flag = None
    voiced_prob = None
    method = None

    if duration <= 300.0:
        def run_pyin():
            return librosa.pyin(
                y, fmin=MIN_NOTE_F0_HZ, fmax=MAX_NOTE_F0_HZ, sr=sr,
                frame_length=2048, hop_length=HOP, n_steps=2, resolution=0.05,
            )

        value, error = _call_with_timeout(run_pyin, timeout_s=180.0)
        if value is not None:
            f0, voiced_flag, voiced_prob = value
            method = f"librosa.pyin ({_librosa_version()})"
        elif error is not None:
            method = f"librosa.piptrack ({_librosa_version()}) [pyin не отработал: {type(error).__name__}]"
        else:
            method = f"librosa.piptrack ({_librosa_version()}) [pyin не уложился в 180 с]"
    else:
        method = f"librosa.piptrack ({_librosa_version()}) [трек длиннее 300 с — pyin пропущен]"

    if f0 is None:
        pitches, magnitudes = librosa.piptrack(
            y=y, sr=sr, fmin=MIN_NOTE_F0_HZ, fmax=MAX_NOTE_F0_HZ, hop_length=HOP
        )
        pitches = np.asarray(pitches)[0]
        magnitudes = np.asarray(magnitudes)[0]
        threshold = float(np.percentile(magnitudes, 60.0)) if magnitudes.size else 0.0
        f0 = pitches
        voiced_flag = magnitudes > threshold
        peak = float(np.max(magnitudes)) if magnitudes.size else 0.0
        voiced_prob = np.clip(magnitudes / peak, 0.0, 1.0) if peak > 1e-12 else np.zeros_like(magnitudes)

    f0 = np.asarray(f0, dtype=np.float64)
    voiced_flag = np.asarray(voiced_flag).astype(bool)
    voiced_prob = np.asarray(voiced_prob, dtype=np.float64)
    if f0.ndim > 1:
        f0 = f0[0]
    if voiced_prob.ndim > 1:
        voiced_prob = voiced_prob[0]

    times = librosa.frames_to_time(np.arange(len(f0)), sr=sr, hop_length=HOP)

    raw_notes = _notes_from_frames(times, f0, voiced_prob, voiced_flag, HOP / float(sr))
    notes = []
    for note in raw_notes:
        f0_value = note["f0_hz"]
        if not (MIN_NOTE_F0_HZ <= f0_value <= MAX_NOTE_F0_HZ):
            continue
        if note["confidence"] < MIN_NOTE_CONFIDENCE:
            continue
        if note["duration_s"] < MIN_NOTE_DURATION_S:
            continue
        notes.append({
            "time_s": _num(note["time_s"], 3),
            "duration_s": _num(note["duration_s"], 3),
            "midi": int(note["midi"]),
            "note_name": note["note_name"],
            "f0_hz": _num(note["f0_hz"], 2),
            "confidence": _num(note["confidence"], 3),
        })

    f0_values = [note["f0_hz"] for note in notes]
    median_f0 = float(np.median(f0_values)) if f0_values else None

    return {
        "notes": notes,
        "median_f0_hz": _num(median_f0, 2),
        "method": method,
    }
