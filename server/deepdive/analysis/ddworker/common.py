# -*- coding: utf-8 -*-
"""
Общая часть DD-воркера: константы, ленивый импорт и базовые утилиты.

Здесь живёт всё, что нужно нескольким модулям сразу:
  * константы анализа (SR, HOP, названия нот, профили Крумхансля, шаблоны
    аккордов, пороги MIN_*);
  * _LazyModule — ленивый импорт numpy/librosa: окружение может не иметь
    librosa при старте сервера, поэтому /health обязан отвечать без него;
  * мелкие помощники (_mod/_ver/_clamp/_num/_note_name/_require_file);
  * загрузка аудио (load_audio) и RMS-огибающая (rms_envelope).
"""

from __future__ import annotations

import importlib
import math
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
