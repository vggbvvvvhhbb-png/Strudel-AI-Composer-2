# -*- coding: utf-8 -*-
"""
Пакет DD-воркера режима «Разбор» (Deep Dive).

Монолитный worker.py разбит по ответственности:
  * common.py    — константы, ленивый импорт numpy/librosa, утилиты, аудио;
  * tempo.py     — темп и кандидаты BPM;
  * key.py       — тональность по хромаграмме и профилям Крумхансля;
  * loudness.py  — громкость по ffmpeg ebur128 (с запасным путём);
  * structure.py — секции по самоподобию и новизне Фута;
  * pitch.py     — питч-трек баса (pyin/piptrack);
  * chords.py    — аккорды-гипотезы по стему other;
  * stems.py     — активность по секциям и кривая энергии;
  * http.py      — HTTP-маршруты и main().

Точка входа — соседний файл worker.py: он подключает пакет и вызывает main().
"""

from __future__ import annotations

from .chords import analyze_chords
from .common import load_audio, np, rms_envelope
from .http import (
    DDHandler,
    handle_analyze,
    handle_analyze_stems,
    handle_separate,
    health_payload,
    main,
)
from .key import analyze_key
from .loudness import analyze_loudness
from .pitch import analyze_bass_pitch
from .structure import analyze_structure
from .tempo import analyze_tempo

__all__ = [
    "DDHandler",
    "analyze_bass_pitch",
    "analyze_chords",
    "analyze_key",
    "analyze_loudness",
    "analyze_structure",
    "analyze_tempo",
    "handle_analyze",
    "handle_analyze_stems",
    "handle_separate",
    "health_payload",
    "load_audio",
    "main",
    "np",
    "rms_envelope",
]
