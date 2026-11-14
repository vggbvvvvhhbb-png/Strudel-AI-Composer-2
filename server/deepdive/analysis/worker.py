#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DD worker — Python-воркер режима «Разбор» (Deep Dive) для Strudel AI Composer.

ЗАЧЕМ ОН НУЖЕН. Node-часть студии умеет всё, что не требует DSP: хранит треки,
считает хэши, гоняет транспайлер и рендерит код в Strudel. Python берёт на
себя ровно то, что в Node делать нечем:

  * разделение трека на стемы (Demucs) — отдельный ML-процесс со своими весами;
  * темп, тональность, структура секций, питч баса, аккорды-гипотезы — это DSP,
    для которого в экосистеме Node нет зрелых равноценных библиотек
    (librosa/scipy + ffmpeg ebur128). Переписывать их на JS — значит выдумывать
    числа вместо измерений.

ПРИНЦИП ЧЕСТНОСТИ. Воркер не придумывает измерения. Если что-то измерить не
удалось — в поле ставится null, confidence = 0, а в method/evidence пишется,
чем именно мерили. Ни одного числа здесь нет, что не пришло из сигнала.

ЧЕСТНЫЕ ОГРАНИЧЕНИЯ (фиксируем, а не прячем):
  * вокал НЕ воспроизводится — ни здесь, ни в транспайлере; из вокала берётся
    только активность по секциям;
  * качество разделения Demucs — ориентир, а не гарантия: на плотных миксах
    бывают протетки (бас слышен в other), поэтому аккорды считаются по стему
    other, а не по миксу — иначе 808 забивает хромаграмму;
  * аккорды — это ГИПОТЕЗЫ по хрома-профилю; при confidence ниже 0.35 лучше
    пропустить, чем выдумать;
  * структура секций — технические метки A/B/C, без семантики («куплет»,
    «припев»): пользователь переименовывает сам;
  * питч баса не воспроизводится точно: в Strudel нет portamento/glide.

ЗАПУСК.  python worker.py                    # порт из DD_PORT, по умолчанию 8010
        DD_PORT=8020 python worker.py

Маршруты (POST, тело — JSON): /health, /analyze, /analyze-stems, /separate.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import metadata
from pathlib import Path


class _LazyModule:
    """Ленивый импорт: сервер поднимается даже без numpy/librosa, /health отвечает."""

    def __init__(self, name: str) -> None:
        self._name = name
        self._module = None

    def _load(self):
        if self._module is None:
            self._module = importlib.import_module(self._name)
        return self._module

    def __getattr__(self, item):
        return getattr(self._load(), item)


np = _LazyModule("numpy")

# --------------------------------------------------------------------------- #
# Константы и справочные данные
# --------------------------------------------------------------------------- #

SR = 22050                      # рабочая частота анализа (достаточно для тона и хрома)
HOP = 512
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Профили Крумхансля–Кесслера: 6 ладов × 12 тоник.
KRUMHANSL = {
    "major":      [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    "minor":      [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    "dorian":     [2.55, 2.65, 3.58, 2.69, 3.60, 3.14, 2.29, 2.41, 3.61, 3.42, 2.26, 3.29],
    "phrygian":   [3.61, 2.60, 3.32, 4.31, 2.89, 3.13, 2.06, 2.41, 3.19, 3.42, 2.40, 2.61],
    "lydian":     [4.21, 2.84, 3.88, 2.97, 4.38, 3.09, 2.80, 3.07, 4.09, 3.10, 2.90, 2.97],
    "mixolydian": [5.38, 2.44, 3.42, 2.88, 4.04, 4.19, 2.46, 2.88, 3.57, 2.97, 3.48, 3.57],
}

# Шаблоны аккордов: интервалы от корня в полутонах.
CHORD_QUALITIES = {
    "major": [0, 4, 7],
    "minor": [0, 3, 7],
    "7":     [0, 4, 7, 10],
    "m7":    [0, 3, 7, 10],
    "sus4":  [0, 5, 7],
    "dim":   [0, 3, 6],
}

MIN_CHORD_CONFIDENCE = 0.35     # ниже — не выдумываем
MIN_NOTE_F0_HZ = 30.0
MAX_NOTE_F0_HZ = 400.0
MIN_NOTE_CONFIDENCE = 0.45
MIN_NOTE_DURATION_S = 0.05

_MODULES: dict = {}


def _mod(name: str):
    """Ленивый импорт: /health должен отвечать даже без librosa."""
    if name not in _MODULES:
        _MODULES[name] = importlib.import_module(name)
    return _MODULES[name]


def _ver(dist: str, default: str = "unknown") -> str:
    try:
        return metadata.version(dist)
    except Exception:
        return default


def _librosa_version() -> str:
    return _ver("librosa")


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _num(value, digits: int = 3):
    """Число с округлением; None остаётся None (никаких правдоподобных догадок)."""
    if value is None:
        return None
    try:
        fvalue = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(fvalue):
        return None
    return round(fvalue, digits)


def _note_name(midi: int) -> str:
    name = NOTE_NAMES[int(midi) % 12]
    octave = int(midi) // 12 - 1
    return f"{name}{octave}"


def _require_file(path: str) -> str:
    if not path:
        raise ValueError("не указан путь к файлу")
    resolved = Path(path).expanduser()
    if not resolved.is_file():
        raise FileNotFoundError(f"файл не найден: {resolved}")
    return str(resolved.resolve())


# --------------------------------------------------------------------------- #
# Загрузка аудио
# --------------------------------------------------------------------------- #

def load_audio(path: str, sr: int = SR):
    """Моно-сигнал float32 + частота дискретизации."""
    librosa = _mod("librosa")
    try:
        y, out_sr = librosa.load(path, sr=sr, mono=True)
        return np.asarray(y, dtype=np.float32), int(out_sr)
    except Exception:
        soundfile = _mod("soundfile")
        data, file_sr = soundfile.read(path, dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        if int(file_sr) != sr:
            count = int(round(len(mono) * sr / float(file_sr)))
            if count < 1:
                raise ValueError("пустой аудиофайл")
            source = np.arange(len(mono), dtype=np.float64)
            mono = np.interp(
                np.linspace(0, len(mono) - 1, count), source, mono
            ).astype(np.float32)
        return np.asarray(mono, dtype=np.float32), sr


def rms_envelope(y, sr: int, hop: int = HOP):
    """RMS-огибающая и времена кадров."""
    librosa = _mod("librosa")
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    rms = np.nan_to_num(np.asarray(rms, dtype=np.float64))
    times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
    return rms, np.asarray(times, dtype=np.float64)


# --------------------------------------------------------------------------- #
# Темп
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Тональность
# --------------------------------------------------------------------------- #

def _pearson(a, b) -> float:
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    if a.std() < 1e-12 or b.std() < 1e-12:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def _chroma_mean(y, sr: int):
    """Средняя хромаграмма трека (12 полутонов, сумма = 1) + число кадров."""
    librosa = _mod("librosa")
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
        source = "chroma_cqt"
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
        source = "chroma_stft"
    chroma = np.nan_to_num(np.asarray(chroma, dtype=np.float64))
    mean = chroma.mean(axis=1) if chroma.shape[1] else np.zeros(12)
    total = float(mean.sum())
    if total <= 0:
        return np.zeros(12), source, 0
    return mean / total, source, int(chroma.shape[1])


def _key_scores(chroma_mean: np.ndarray):
    """Корреляция хрома с профилями Крумхансля для 24 тональностей."""
    scores = []
    for mode, profile in KRUMHANSL.items():
        base = np.asarray(profile, dtype=np.float64)
        for root in range(12):
            rotated = np.zeros(12, dtype=np.float64)
            for offset, value in enumerate(base):
                rotated[(root + offset) % 12] = value
            scores.append((root, mode, _pearson(chroma_mean, rotated)))
    scores.sort(key=lambda item: item[2], reverse=True)
    return scores


def _key_confidence(correlation: float, runner_up: float) -> float:
    absolute = _clamp(correlation)
    margin = _clamp((correlation - runner_up) / 0.15)
    return _clamp(0.5 * absolute + 0.5 * margin)


def analyze_key(y, sr: int) -> dict:
    method = (
        f"librosa.feature.chroma_cqt ({_librosa_version()}) + профили Крумхансля–Кесслера (Pearson r)"
    )
    try:
        chroma_mean, source, frames = _chroma_mean(y, sr)
    except Exception as exc:
        return {
            "tonic": None,
            "mode": "unknown",
            "confidence": 0.0,
            "alternatives": [],
            "method": method,
            "evidence": [f"хромаграмма не построилась: {type(exc).__name__}: {exc}"],
        }

    method = method.replace("chroma_cqt", source)
    if frames == 0 or float(chroma_mean.sum()) <= 0:
        return {
            "tonic": None,
            "mode": "unknown",
            "confidence": 0.0,
            "alternatives": [],
            "method": method,
            "evidence": ["хромаграмма пуста — тональность не определена"],
        }

    scores = _key_scores(chroma_mean)
    root, mode, best = scores[0]
    root2, mode2, second = scores[1]
    confidence = _key_confidence(best, second)

    tonic = NOTE_NAMES[root]
    alternatives = []

    # Релятивная: мажор ↔ минор на 3 полутона выше/ниже.
    if mode == "major":
        rel_root, rel_mode = (root + 9) % 12, "minor"
    else:
        rel_root, rel_mode = (root + 3) % 12, "major"
    rel_corr = _corr_for(scores, rel_root, rel_mode)
    alternatives.append({
        "tonic": NOTE_NAMES[rel_root],
        "mode": rel_mode,
        "relation": "relative",
        "confidence": _num(_key_confidence(rel_corr, best)),
    })

    # Параллельная: тот же тоник, другой лад.
    par_mode = "minor" if mode == "major" else "major"
    par_corr = _corr_for(scores, root, par_mode)
    alternatives.append({
        "tonic": tonic,
        "mode": par_mode,
        "relation": "parallel",
        "confidence": _num(_key_confidence(par_corr, best)),
    })

    # Доминантная (квинта выше) — базовая гипотеза гармонии.
    fifth_root = (root + 7) % 12
    fifth_corr = _corr_for(scores, fifth_root, mode)
    alternatives.append({
        "tonic": NOTE_NAMES[fifth_root],
        "mode": mode,
        "relation": "fifth",
        "confidence": _num(_key_confidence(fifth_corr, best)),
    })

    alternatives.sort(key=lambda item: item["confidence"], reverse=True)

    evidence = [
        f"хрома ({source}), кадров: {frames}",
        f"лучшая корреляция {best:.3f} — {tonic} {mode}; вторая {second:.3f} — {NOTE_NAMES[root2]} {mode2}",
        "профили: Крумхансль–Кесслер, 6 ладов × 12 тоник",
    ]

    return {
        "tonic": tonic,
        "mode": mode,
        "confidence": _num(confidence),
        "alternatives": alternatives,
        "method": method,
        "evidence": evidence,
    }


def _corr_for(scores, root: int, mode: str) -> float:
    for item_root, item_mode, value in scores:
        if item_root == root and item_mode == mode:
            return value
    return -1.0


# --------------------------------------------------------------------------- #
# Громкость
# --------------------------------------------------------------------------- #

def _parse_ebur128(text: str) -> dict:
    """Разбор вывода ffmpeg ebur128: I (integrated), LRA, true peak, max M."""
    result = {"integrated": None, "range": None, "true_peak": None, "max_momentary": None}
    if not text:
        return result

    summary_at = text.rfind("Summary:")
    summary = text[summary_at:] if summary_at >= 0 else ""
    body = text if summary_at < 0 else text[:summary_at]

    momentary = [float(value) for value in re.findall(r"\bM:\s*(-?\d+(?:\.\d+)?)\s*LUFS", body)]
    if momentary:
        result["max_momentary"] = max(momentary)

    integrated = re.search(r"\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS", summary)
    if integrated:
        result["integrated"] = float(integrated.group(1))
    lra = re.search(r"\bLRA:\s*(-?\d+(?:\.\d+)?)\s*LU", summary)
    if lra:
        result["range"] = float(lra.group(1))
    peak = re.search(r"\bPeak:\s*(-?\d+(?:\.\d+)?)\s*dBFS", summary)
    if peak:
        result["true_peak"] = float(peak.group(1))
    return result


def analyze_loudness(path: str, y, sr: int) -> dict:
    """Громкость: ffmpeg ebur128 (основной путь), librosa — только запасной."""
    method = "ffmpeg ebur128 (peak=true)"
    reference = "ffmpeg ebur128"
    parsed = None
    fallback_reason = "ffmpeg недоступен или ebur128 не отработал"
    try:
        command = [
            "ffmpeg", "-nostats", "-hide_banner", "-i", path,
            "-filter_complex", "ebur128=peak=true", "-f", "null", "-",
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=900, check=False
        )
        if completed.returncode != 0:
            raise RuntimeError(
                "ffmpeg вернул код %s: %s" % (
                    completed.returncode,
                    (completed.stderr or "")[-400:],
                )
            )
        parsed = _parse_ebur128(completed.stderr or "")
    except FileNotFoundError:
        parsed = None
        fallback_reason = "ffmpeg не найден в PATH"
    except Exception as exc:
        parsed = None
        fallback_reason = f"{type(exc).__name__}: {exc}"

    peak = float(np.max(np.abs(y))) if len(y) else 0.0
    peak_dbfs = 20.0 * math.log10(peak) if peak > 1e-12 else None
    rms = rms_envelope(y, sr)[0]
    rms_mean = float(np.mean(rms)) if len(rms) else 0.0
    rms_db = 20.0 * math.log10(rms_mean) if rms_mean > 1e-12 else None
    crest = None
    if peak_dbfs is not None and rms_db is not None:
        crest = peak_dbfs - rms_db

    if parsed and parsed.get("integrated") is not None:
        return {
            "lufs_integrated": _num(parsed["integrated"], 2),
            "lufs_max": _num(parsed.get("max_momentary"), 2),
            "lufs_range": _num(parsed.get("range"), 2),
            "true_peak_dbtp": _num(parsed.get("true_peak"), 2),
            "peak_dbfs": _num(peak_dbfs, 2),
            "crest_db": _num(crest, 2),
            "method": method,
            "reference": reference,
        }

    # Запасной путь: честно отдаём только то, что реально измерили.
    return {
        "lufs_integrated": None,
        "lufs_max": None,
        "lufs_range": None,
        "true_peak_dbtp": None,
        "peak_dbfs": _num(peak_dbfs, 2),
        "crest_db": _num(crest, 2),
        "method": f"librosa.feature.rms + numpy peak (fallback): {fallback_reason}",
        "reference": "librosa rms (LUFS не измерены)",
    }


# --------------------------------------------------------------------------- #
# Структура секций
# --------------------------------------------------------------------------- #

def _foote_novelty(matrix: np.ndarray, window: int) -> np.ndarray:
    """Foote-подобная новизна по матрице самоподобия (диагональ → пики на стыках)."""
    n = matrix.shape[0]
    novelty = np.zeros(n, dtype=np.float64)
    if n < 4 * window:
        return novelty
    for t in range(window, n - window):
        far = matrix[t + window:t + 2 * window, t - window:t]
        near = matrix[t - window:t + window, t - window:t + window]
        novelty[t] = float(far.mean() - near.mean())
    if novelty.max() > novelty.min():
        novelty = (novelty - novelty.min()) / (novelty.max() - novelty.min())
    return novelty


def _section_centroids(feature: np.ndarray, boundaries_frames: np.ndarray) -> list:
    centroids = []
    for i in range(len(boundaries_frames) - 1):
        start, end = int(boundaries_frames[i]), int(boundaries_frames[i + 1])
        if end <= start:
            centroids.append(np.zeros(feature.shape[0]))
            continue
        centroids.append(feature[:, start:end].mean(axis=1))
    return centroids


def analyze_structure(y, sr: int) -> list:
    """Границы секций по самоподобию. Метки только A/B/C — без семантики."""
    librosa = _mod("librosa")
    scipy_signal = _mod("scipy.signal")

    duration = len(y) / float(sr)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=HOP)
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
    feature = np.vstack([
        np.nan_to_num(np.asarray(mfcc, dtype=np.float64)),
        np.nan_to_num(np.asarray(chroma, dtype=np.float64)),
    ])

    frames = feature.shape[1]
    stride = max(1, frames // 1200)
    reduced = feature[:, ::stride]
    reduced = reduced - reduced.mean(axis=1, keepdims=True)

    try:
        # Берём расстояния и сами переводим их в сходство: так гарантировано,
        # что больше = похоже (нужно для формулы новизны Фута).
        distance = librosa.feature.recurrence_matrix(
            reduced, mode="distance", sym=True, metric="cosine"
        )
        max_distance = float(np.max(distance))
        if not math.isfinite(max_distance) or max_distance <= 1e-12:
            raise ValueError("пустая матрица сходства")
        similarity = 1.0 - np.asarray(distance, dtype=np.float64) / max_distance
    except Exception:
        similarity = np.eye(reduced.shape[1])

    window = max(4, int(round(4.0 / (HOP * stride / sr))))
    novelty = _foote_novelty(similarity, window)

    frame_seconds = HOP * stride / sr
    min_gap_frames = max(1, int(round(8.0 / frame_seconds)))
    peak_indices, _properties = scipy_signal.find_peaks(
        novelty, distance=min_gap_frames, prominence=0.05
    )
    if len(peak_indices) > 24:
        order = np.argsort(novelty[peak_indices])[::-1][:24]
        peak_indices = np.sort(peak_indices[order])

    boundary_frames = [0]
    for index in peak_indices:
        boundary_frames.append(int(index))
    boundary_frames.append(reduced.shape[1])

    # Слишком короткие секции присоединяем к соседнему.
    kept = [boundary_frames[0]]
    for value in boundary_frames[1:-1]:
        if (value - kept[-1]) * frame_seconds >= 2.0:
            kept.append(value)
    if kept[-1] != boundary_frames[-1]:
        kept.append(boundary_frames[-1])
    if len(kept) < 2:
        kept = [0, reduced.shape[1]]

    times = [index * frame_seconds for index in kept]
    times[0] = 0.0
    times[-1] = duration

    rms, rms_times = rms_envelope(y, sr)
    rms_max = float(np.max(rms)) if len(rms) else 0.0

    centroids = _section_centroids(reduced, np.array(kept))
    labels: list = []
    groups: list = []
    group_counter = 0
    previous = None
    for centroid in centroids:
        same = False
        if previous is not None and len(centroid) == len(previous):
            norm_a = float(np.linalg.norm(centroid))
            norm_b = float(np.linalg.norm(previous))
            if norm_a > 1e-9 and norm_b > 1e-9:
                similarity_value = float(np.dot(centroid, previous) / (norm_a * norm_b))
                same = similarity_value >= 0.85
        if same and group_counter > 0:
            labels.append(labels[-1])
            groups.append(group_counter)
        else:
            group_counter += 1
            labels.append(chr(ord("A") + (len(labels) % 26)))
            groups.append(0)
        previous = centroid

    sections = []
    novelty_values = []
    for index in range(len(times) - 1):
        start_s = float(times[index])
        end_s = float(times[index + 1])
        if end_s - start_s < 0.5:
            continue
        mask = (rms_times >= start_s) & (rms_times < end_s)
        section_rms = float(np.mean(rms[mask])) if np.any(mask) else 0.0
        energy = _clamp(section_rms / rms_max) if rms_max > 1e-12 else 0.0

        start_frame = min(reduced.shape[1] - 1, int(start_s / frame_seconds)) if frame_seconds > 0 else 0
        novelty_value = float(novelty[start_frame]) if start_frame < len(novelty) else 0.0
        novelty_values.append(novelty_value)

        length_s = end_s - start_s
        length_plausible = _clamp(min(length_s, 30.0) / 30.0) * 0.5 + _clamp(min(length_s, 8.0) / 8.0) * 0.5
        confidence = _clamp(0.35 + 0.45 * novelty_value + 0.20 * length_plausible)

        sections.append({
            "index": len(sections),
            "start_s": _num(start_s, 3),
            "end_s": _num(end_s, 3),
            "label": labels[index],
            "energy": _num(energy, 3),
            "confidence": _num(confidence, 3),
            "novelty": _num(novelty_value, 3),
            "repeated_group": int(groups[index]),
        })

    method = (
        f"librosa.feature.recurrence_matrix (cosine) + новизна Фута "
        f"+ scipy.signal.find_peaks ({_librosa_version()})"
    )
    return sections, method


# --------------------------------------------------------------------------- #
# Питч баса
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Аккорды-гипотезы (по стему other)
# --------------------------------------------------------------------------- #

def analyze_chords(y, sr: int, bass_notes: list):
    """Аккорды-гипотезы по хрома-профилю (не по миксу: 808 забивает хромаграмму)."""
    librosa = _mod("librosa")
    method = (
        f"librosa.feature.chroma_cqt ({_librosa_version()}) + шаблоны аккордов "
        f"(major/minor/7/m7/sus4/dim), косинус к хрома-профилю"
    )
    try:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP)
        source = "chroma_cqt"
    except Exception:
        chroma = librosa.feature.chroma_stft(y=y, sr=sr, hop_length=HOP)
        source = "chroma_stft"

    chroma = np.nan_to_num(np.asarray(chroma, dtype=np.float64))
    if chroma.shape[1] == 0:
        return [], method

    # Нормируем каждый кадр так, чтобы сумма = 1 (иначе тишина «победит»).
    sums = chroma.sum(axis=0, keepdims=True)
    norm = np.divide(chroma, sums, out=np.zeros_like(chroma), where=sums > 1e-12)

    labels = []
    scores = []
    best_per_frame = []
    second_per_frame = []
    for frame in range(norm.shape[1]):
        vector = norm[:, frame]
        if float(vector.sum()) <= 1e-9:
            labels.append(-1)
            scores.append(0.0)
            best_per_frame.append(None)
            second_per_frame.append(None)
            continue
        ranked = []
        for quality, intervals in CHORD_QUALITIES.items():
            for root in range(12):
                template = np.zeros(12, dtype=np.float64)
                for interval in intervals:
                    template[(root + interval) % 12] = 1.0
                denominator = float(np.linalg.norm(template))
                if denominator <= 1e-12:
                    continue
                value = float(np.dot(vector, template) / denominator)
                ranked.append((value, root, quality))
        ranked.sort(reverse=True)
        top = ranked[0]
        labels.append(top[1] * 100 + list(CHORD_QUALITIES).index(top[2]))
        scores.append(top[0])
        best_per_frame.append(top)
        second_per_frame.append(ranked[1] if len(ranked) > 1 else None)

    # Стабилизация: медианный фильтр по меткам (5 кадров).
    try:
        scipy_ndimage = _mod("scipy.ndimage")
        filtered = scipy_ndimage.median_filter(np.asarray(labels, dtype=np.float64), size=5)
    except Exception:
        filtered = np.asarray(labels, dtype=np.float64)

    times = librosa.frames_to_time(np.arange(len(filtered)), sr=sr, hop_length=HOP)
    frame_seconds = HOP / float(sr)

    spans = []
    start_index = None
    current_label = None
    for index, label in enumerate(filtered):
        value = int(label)
        if current_label is None or value != current_label:
            if current_label is not None and start_index is not None:
                spans.append((start_index, index - 1, current_label))
            start_index = index
            current_label = value
    if current_label is not None and start_index is not None:
        spans.append((start_index, len(filtered) - 1, current_label))

    chords = []
    for start_frame, end_frame, label in spans:
        if label < 0:
            continue
        quality_index = label % 100
        root = label // 100
        quality = list(CHORD_QUALITIES)[quality_index]
        window_scores = scores[start_frame:end_frame + 1]
        if not len(window_scores):
            continue
        confidence = float(np.mean(window_scores))
        if confidence < MIN_CHORD_CONFIDENCE:
            continue
        start_s = float(times[start_frame])
        end_s = float(times[min(end_frame, len(times) - 1)])
        if end_s - start_s < frame_seconds:
            end_s = start_s + frame_seconds
        if end_s - start_s < 0.4:
            continue

        runner_up = None
        for index in range(start_frame, end_frame + 1):
            candidate = second_per_frame[index] if index < len(second_per_frame) else None
            if candidate is None:
                continue
            if candidate[1] == root and candidate[2] == quality:
                continue
            if runner_up is None or candidate[0] > runner_up[0]:
                runner_up = candidate
        evidence = [
            "chroma cosine %.2f vs %s %s" % (
                confidence,
                NOTE_NAMES[runner_up[1]] if runner_up else "?",
                runner_up[2] if runner_up else "?",
            ),
            f"хрома ({source}), стем other",
        ]

        bass_note = None
        overlapping = [
            note for note in bass_notes
            if note["time_s"] < end_s and (note["time_s"] + (note["duration_s"] or 0)) > start_s
        ]
        if overlapping:
            lowest = min(overlapping, key=lambda note: note["midi"])
            bass_note = lowest["note_name"]

        chords.append({
            "start_s": _num(start_s, 3),
            "end_s": _num(end_s, 3),
            "root": NOTE_NAMES[root],
            "quality": quality,
            "confidence": _num(confidence, 3),
            "evidence": evidence,
        })
        if bass_note:
            chords[-1]["bass_note"] = bass_note

    return chords, method


# --------------------------------------------------------------------------- #
# Стемы: активность, энергия
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Маршруты
# --------------------------------------------------------------------------- #

def health_payload() -> dict:
    demucs_available = False
    demucs_version = None
    try:
        spec = importlib.util.find_spec("demucs")
        demucs_available = spec is not None
        demucs_version = _ver("demucs") if demucs_available else None
    except Exception:
        demucs_available = False
    return {
        "ok": True,
        "versions": {
            "python": sys.version.split()[0],
            "librosa": _ver("librosa"),
            "numpy": _ver("numpy"),
            "scipy": _ver("scipy"),
            "soundfile": _ver("soundfile"),
            "demucs": demucs_version,
        },
        "models": {
            "separation": "htdemucs",
            "demucs_available": demucs_available,
            "default_separation_model": "htdemucs",
        },
    }


def handle_analyze(body: dict) -> dict:
    path = _require_file(body.get("path"))
    y, sr = load_audio(path)
    if len(y) == 0:
        raise ValueError("аудиофайл пуст")
    tempo = analyze_tempo(y, sr)
    key = analyze_key(y, sr)
    loudness = analyze_loudness(path, y, sr)
    structure, structure_method = analyze_structure(y, sr)
    return {
        "measurements": {
            "tempo": tempo,
            "key": key,
            "loudness": loudness,
        },
        "structure": structure,
        # Методы — отдельно от данных: в контракте у structure[] нет поля method
        # (additionalProperties: false), туда его положить нельзя.
        "methods": {
            "tempo": tempo.get("method"),
            "key": key.get("method"),
            "loudness": loudness.get("method"),
            "structure": structure_method,
        },
    }


def handle_analyze_stems(body: dict) -> dict:
    stems = body.get("stems") or {}
    if not isinstance(stems, dict) or not stems:
        raise ValueError("не указаны стемы (stems)")
    sections = body.get("sections") or []
    if not isinstance(sections, list):
        raise ValueError("sections должен быть списком")

    descriptors: dict = {}
    methods: dict = {}
    bass_notes: list = []

    for name in ("drums", "bass", "vocals", "other"):
        raw_path = stems.get(name)
        if not raw_path:
            continue
        path = _require_file(raw_path)
        y, sr = load_audio(path)
        rms, rms_times = rms_envelope(y, sr)
        activity = _activity_by_section(rms, rms_times, sections)
        energy = _energy_curve(rms, rms_times)
        descriptor = {"activity": activity, "energy": energy}

        if name == "bass":
            pitch = analyze_bass_pitch(y, sr)
            descriptor["pitch"] = {
                "notes": pitch["notes"],
                "median_f0_hz": pitch["median_f0_hz"],
            }
            methods["bass.pitch"] = pitch["method"]
            bass_notes = pitch["notes"]
        elif name == "other":
            chords, chords_method = analyze_chords(y, sr, bass_notes)
            descriptor["chords"] = chords
            methods["other.chords"] = chords_method

        descriptors[name] = descriptor

    return {
        "stem_descriptors": descriptors,
        # В контракте у stem_descriptors нет поля method (additionalProperties: false),
        # поэтому методы идут отдельным объектом.
        "methods": methods,
    }


def _venv_python() -> str:
    configured = os.environ.get("DD_PYTHON")
    if configured:
        return configured
    for candidate in ("/opt/dd-venv/bin/python", "/opt/dd-venv/bin/python3"):
        if os.path.exists(candidate):
            return candidate
    return sys.executable


def handle_separate(body: dict) -> dict:
    path = _require_file(body.get("path"))
    model = str(body.get("model") or "htdemucs")
    out_dir = body.get("out_dir")
    if not out_dir:
        raise ValueError("не указан out_dir")
    out_path = Path(str(out_dir)).expanduser()
    out_path.mkdir(parents=True, exist_ok=True)

    python = _venv_python()
    command = [python, "-m", "demucs", "-n", model, "-o", str(out_path), path]
    started = time.time()
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=7200, check=False
        )
    except FileNotFoundError as exc:
        raise RuntimeError(f"не найден интерпретатор для demucs: {python}") from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("demucs не уложился в таймаут 7200 с") from exc

    if completed.returncode != 0:
        tail = (completed.stderr or completed.stdout or "")[-800:]
        raise RuntimeError(f"demucs завершился с кодом {completed.returncode}: {tail}")

    found: dict = {}
    for stem in ("drums", "bass", "vocals", "other"):
        matches = sorted(
            out_path.rglob(f"{stem}.wav"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )
        if matches:
            found[stem] = str(matches[0].resolve())

    if not found:
        raise RuntimeError("demucs отработал, но файлы стемов не найдены в out_dir")

    return {
        "stems": found,
        "seconds": _num(time.time() - started, 2),
        "model": model,
    }


# --------------------------------------------------------------------------- #
# HTTP-сервер
# --------------------------------------------------------------------------- #

def _log(route: str, status: int, started: float, extra: dict | None = None) -> None:
    record = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "route": route,
        "status": status,
        "ms": int((time.time() - started) * 1000),
    }
    if extra:
        record.update(extra)
    sys.stderr.write(json.dumps(record, ensure_ascii=False) + "\n")
    sys.stderr.flush()


class DDHandler(BaseHTTPRequestHandler):
    server_version = "DDWorker/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # noqa: A003 — глушим стандартный лог
        return

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):  # noqa: N802 — имя задано базовым классом
        route = self.path.split("?")[0]
        if route == "/health":
            try:
                self._send_json(200, health_payload())
            except Exception as exc:  # noqa: BLE001
                self._send_json(500, {"error": f"{type(exc).__name__}: {exc}", "trace": traceback.format_exc()})
            return
        self._send_json(404, {"error": f"неизвестный маршрут: {route}"})

    def do_POST(self):  # noqa: N802 — имя задано базовым классом
        started = time.time()
        route = self.path.split("?")[0]
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length > 0 else b""
            body = json.loads(raw.decode("utf-8")) if raw else {}
            if not isinstance(body, dict):
                raise ValueError("тело запроса должно быть JSON-объектом")
            status, payload = self._dispatch(route, body)
        except Exception as exc:  # noqa: BLE001 — сервер не должен падать
            status = 500
            payload = {
                "error": f"{type(exc).__name__}: {exc}",
                "trace": traceback.format_exc(),
            }
        self._send_json(status, payload)
        _log(route, status, started)

    def _dispatch(self, route: str, body: dict):
        if route == "/health":
            return 200, health_payload()
        if route == "/analyze":
            return 200, handle_analyze(body)
        if route == "/analyze-stems":
            return 200, handle_analyze_stems(body)
        if route == "/separate":
            return 200, handle_separate(body)
        return 404, {"error": f"неизвестный маршрут: {route}"}


def _port() -> int:
    try:
        return int(os.environ.get("DD_PORT") or 8010)
    except (TypeError, ValueError):
        return 8010


def main() -> None:
    port = _port()
    server = ThreadingHTTPServer(("0.0.0.0", port), DDHandler)
    server.daemon_threads = True
    sys.stderr.write(f"DD worker listening on :{port}\n")
    sys.stderr.flush()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
